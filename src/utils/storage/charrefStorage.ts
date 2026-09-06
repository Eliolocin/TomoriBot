import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "@/utils/misc/logger";
import { MEDIA_LIMITS } from "@/utils/security/rateLimiter";
import { safeDownload } from "@/utils/security/safeDownload";

export type CharRefEntityType = "personas" | "users";

export type CharRefUploadOptions = {
  entityType: CharRefEntityType;
  entityId: string | number;
  buffer: Buffer;
};

export type CharRefStorageConfig = {
  bucket: string;
  region: string;
  prefix: string;
  publicBaseUrl: string;
  endpoint?: string;
};

export type CharRefDisplayAsset = { type: "url"; url: string } | { type: "buffer"; buffer: Buffer };

export interface CharRefDisplayResolverDependencies {
  storageConfig?: CharRefStorageConfig | null;
  loadLocalBuffer?: (absolutePath: string) => Promise<Buffer | null>;
}

const IS_PRODUCTION = process.env.RUN_ENV === "production";
const LOCAL_CHARREF_BASE_DIR = path.resolve(process.cwd(), "data", "charreferences");
let cachedClient: S3Client | null = null;
let cachedRegion: string | null = null;
let cachedEndpoint: string | undefined;

function getS3Client(region: string, endpoint?: string): S3Client {
  if (!cachedClient || cachedRegion !== region || cachedEndpoint !== endpoint) {
    cachedRegion = region;
    cachedEndpoint = endpoint;
    cachedClient = new S3Client({
      region,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
  }

  return cachedClient;
}

function getCharRefStorageConfig(): CharRefStorageConfig | null {
  if (!IS_PRODUCTION) {
    return null;
  }

  const bucket = process.env.CHARREF_S3_BUCKET?.trim() || process.env.AVATAR_S3_BUCKET?.trim();
  if (!bucket) {
    log.warn(
      "[CharRef Storage] No CHARREF_S3_BUCKET or AVATAR_S3_BUCKET configured; character reference upload disabled in production.",
    );
    return null;
  }

  const region =
    process.env.CHARREF_S3_REGION?.trim() ||
    process.env.AVATAR_S3_REGION?.trim() ||
    process.env.AWS_REGION?.trim() ||
    "us-east-1";
  const endpoint = process.env.S3_ENDPOINT?.trim() || undefined;
  const prefix = (process.env.CHARREF_S3_PREFIX || "charreferences").replace(/^\/+/, "").replace(/\/+$/, "");
  const publicBaseUrl = process.env.CHARREF_PUBLIC_BASE_URL?.trim() || `https://${bucket}.s3.${region}.amazonaws.com`;

  return {
    bucket,
    region,
    prefix,
    publicBaseUrl,
    endpoint,
  };
}

function buildPublicUrl(config: CharRefStorageConfig, key: string): string {
  const baseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return `${baseUrl}/${key}`;
}

function buildObjectKey(config: CharRefStorageConfig, options: CharRefUploadOptions): string {
  const timestamp = Date.now();
  return `${config.prefix}/${options.entityType}/${String(options.entityId)}/${timestamp}.png`;
}

function buildLocalStoredPath(options: CharRefUploadOptions): string {
  const timestamp = Date.now();
  return path.posix.join("data", "charreferences", options.entityType, String(options.entityId), `${timestamp}.png`);
}

function resolveLocalCharRefPath(storedPath: string): string | null {
  const normalizedPath = storedPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const resolvedPath = path.resolve(process.cwd(), normalizedPath);
  const relativePath = path.relative(LOCAL_CHARREF_BASE_DIR, resolvedPath);

  if (relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))) {
    return resolvedPath;
  }

  log.warn(`[CharRef Storage] Rejected path outside data/charreferences: ${storedPath}`);
  return null;
}

function resolvePersonaLocalCharRefPath(storedPath: string, personaId: number): string | null {
  const normalizedPath = storedPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const personaPrefix = `data/charreferences/personas/${String(personaId)}/`;
  if (!normalizedPath.startsWith(personaPrefix)) {
    return null;
  }

  const resolvedPath = resolveLocalCharRefPath(storedPath);
  if (!resolvedPath) {
    return null;
  }

  const personaBaseDir = path.resolve(process.cwd(), "data", "charreferences", "personas", String(personaId));
  const relativePath = path.relative(personaBaseDir, resolvedPath);
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    log.warn(`[CharRef Storage] Rejected character reference path for persona ${personaId}: ${storedPath}`);
    return null;
  }

  return resolvedPath;
}

function extractKeyFromRemoteUrl(config: CharRefStorageConfig, url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    const baseHost = new URL(config.publicBaseUrl).hostname;
    const hostname = parsedUrl.hostname;
    const pathName = parsedUrl.pathname.replace(/^\/+/, "");

    if (hostname !== baseHost) {
      const s3Host = `${config.bucket}.s3.${config.region}.amazonaws.com`;
      const s3HostLegacy = `${config.bucket}.s3.amazonaws.com`;
      if (hostname !== s3Host && hostname !== s3HostLegacy) {
        return null;
      }
    }

    if (!pathName.startsWith(`${config.prefix}/`)) {
      return null;
    }

    return pathName;
  } catch {
    return null;
  }
}

function extractKeyFromConfiguredPublicUrl(config: CharRefStorageConfig, url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    const publicBaseUrl = new URL(config.publicBaseUrl);
    if (parsedUrl.origin !== publicBaseUrl.origin) {
      return null;
    }

    const basePath = decodeURIComponent(publicBaseUrl.pathname).replace(/^\/+|\/+$/g, "");
    const pathName = decodeURIComponent(parsedUrl.pathname).replace(/^\/+/, "");
    const relativePath = basePath
      ? pathName.startsWith(`${basePath}/`)
        ? pathName.slice(basePath.length + 1)
        : null
      : pathName;
    if (!relativePath?.startsWith(`${config.prefix}/`)) {
      return null;
    }

    return relativePath;
  } catch {
    return null;
  }
}

export async function resolveCharRefDisplayAsset(
  reference: string | null | undefined,
  personaId: number,
  dependencies: CharRefDisplayResolverDependencies = {},
): Promise<CharRefDisplayAsset | null> {
  const target = reference?.trim();
  if (!target) {
    return null;
  }

  if (/^https?:\/\//i.test(target)) {
    const config = dependencies.storageConfig === undefined ? getCharRefStorageConfig() : dependencies.storageConfig;
    if (!config) {
      return null;
    }

    const key = extractKeyFromConfiguredPublicUrl(config, target);
    const ownerPrefix = `${config.prefix}/personas/${String(personaId)}/`;
    if (!key?.startsWith(ownerPrefix) || key.length === ownerPrefix.length) {
      return null;
    }

    return { type: "url", url: target };
  }

  const absolutePath = resolvePersonaLocalCharRefPath(target, personaId);
  if (!absolutePath) {
    return null;
  }

  try {
    const buffer = dependencies.loadLocalBuffer
      ? await dependencies.loadLocalBuffer(absolutePath)
      : await fs.readFile(absolutePath);
    return buffer ? { type: "buffer", buffer } : null;
  } catch (error) {
    log.warn(`[CharRef Storage] Failed to load local character reference ${target}`, error);
    return null;
  }
}

export async function uploadCharRef(options: CharRefUploadOptions): Promise<string | null> {
  if (IS_PRODUCTION) {
    const config = getCharRefStorageConfig();
    if (!config) {
      return null;
    }

    const key = buildObjectKey(config, options);
    const client = getS3Client(config.region, config.endpoint);

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: options.buffer,
          ContentType: "image/png",
          CacheControl: "public, max-age=31536000, immutable",
        }),
      );

      const publicUrl = buildPublicUrl(config, key);
      log.success(`[CharRef Storage] Uploaded ${options.entityType} character reference to ${publicUrl}`);
      return publicUrl;
    } catch (error) {
      log.warn(`[CharRef Storage] Failed to upload ${options.entityType} character reference to S3`, error);
      return null;
    }
  }

  const storedPath = buildLocalStoredPath(options);
  const absolutePath = resolveLocalCharRefPath(storedPath);
  if (!absolutePath) {
    return null;
  }

  try {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, options.buffer);
    log.success(`[CharRef Storage] Stored ${options.entityType} character reference at ${storedPath}`);
    return storedPath.replace(/\\/g, "/");
  } catch (error) {
    log.warn(`[CharRef Storage] Failed to store ${options.entityType} character reference locally`, error);
    return null;
  }
}

export async function deleteCharRef(urlOrPath: string): Promise<boolean> {
  const target = urlOrPath.trim();
  if (!target) {
    return false;
  }

  if (/^https?:\/\//i.test(target)) {
    const config = getCharRefStorageConfig();
    if (!config) {
      return false;
    }

    const key = extractKeyFromRemoteUrl(config, target);
    if (!key) {
      return false;
    }

    try {
      await getS3Client(config.region, config.endpoint).send(
        new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: key,
        }),
      );
      log.info(`[CharRef Storage] Deleted remote character reference ${key}`);
      return true;
    } catch (error) {
      log.warn(`[CharRef Storage] Failed to delete remote character reference ${key}`, error);
      return false;
    }
  }

  const absolutePath = resolveLocalCharRefPath(target);
  if (!absolutePath) {
    return false;
  }

  try {
    await fs.unlink(absolutePath);
    log.info(`[CharRef Storage] Deleted local character reference ${target.replace(/\\/g, "/")}`);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }

    log.warn(`[CharRef Storage] Failed to delete local character reference ${target}`, error);
    return false;
  }
}

export async function loadCharRefAsBase64(urlOrPath: string): Promise<string | null> {
  const target = urlOrPath.trim();
  if (!target) {
    return null;
  }

  if (/^https?:\/\//i.test(target)) {
    try {
      const downloadResult = await safeDownload(target, {
        maxSizeMB: MEDIA_LIMITS.MAX_MEDIA_SIZE_MB,
        timeoutMs: 15_000,
      });
      if (!downloadResult.success || !downloadResult.buffer) {
        log.warn(`[CharRef Storage] Failed to fetch remote character reference (${downloadResult.details})`);
        return null;
      }

      return downloadResult.buffer.toString("base64");
    } catch (error) {
      log.warn(`[CharRef Storage] Failed to load remote character reference ${target}`, error);
      return null;
    }
  }

  const absolutePath = resolveLocalCharRefPath(target);
  if (!absolutePath) {
    return null;
  }

  try {
    const buffer = await fs.readFile(absolutePath);
    return buffer.toString("base64");
  } catch (error) {
    log.warn(`[CharRef Storage] Failed to load local character reference ${target}`, error);
    return null;
  }
}
