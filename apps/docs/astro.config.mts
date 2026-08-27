import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";
import starlightLlmsTxt from "starlight-llms-txt";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Starlight's autogenerate resolves pages by stripping the hardcoded
// "src/content/docs/" prefix from each entry's filePath (relative to project
// root). When the docs live outside the Astro project (../../docs), filePath
// becomes "../../docs/..." and the prefix strip never matches, leaving every
// sidebar group empty.
//
// Fix: create a junction/symlink at src/content/docs → ../../docs so that
// Astro sees the files as src/content/docs/... (correct prefix). This runs
// once at startup; on Windows it creates a directory junction (no admin
// required); on Linux/macOS it falls back to a regular symlink.
const __dirname = dirname(fileURLToPath(import.meta.url));
const junctionPath = resolve(__dirname, "src/content/docs");
const docsTarget = resolve(__dirname, "../../docs");
const enDocsTarget = resolve(docsTarget, "en");

if (!existsSync(junctionPath)) {
  mkdirSync(resolve(__dirname, "src/content"), { recursive: true });
  symlinkSync(docsTarget, junctionPath, "junction");
}

// Sidebar source of truth:
// - Top-level groups are discovered from docs/*/README.md.
// - Page links use each Markdown file's `title`.
// - Folder groups use `sidebar.groupLabel` from that folder's README when present.
// - Ordering uses `sidebar.order` only where filename order is not enough.
// - Set `sidebar.hidden: true` on a top-level README to keep that folder out of main nav.
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const maxOrder = Number.MAX_SAFE_INTEGER;

const segmentLabelOverrides = {
  ai: "AI",
  api: "API",
  db: "DB",
  discord: "Discord",
  ltm: "LTM",
  mcp: "MCP",
  novelai: "NovelAI",
  rag: "RAG",
  sillytavern: "SillyTavern",
  stm: "STM",
  stt: "STT",
  tts: "TTS",
};

function buildSidebarSection(directory) {
  const dirPath = resolve(enDocsTarget, directory);
  const readmePath = getReadmePath(dirPath);
  const readmeData = readmePath ? readFrontmatter(readmePath) : {};
  const jaLabel = getJaGroupLabel(dirPath, directory);

  return {
    label: getGroupLabel(readmeData, directory),
    collapsed: true,
    items: buildDirectoryItems(dirPath, directory).map((node) => node.item),
    ...(jaLabel ? { translations: { ja: jaLabel } } : {}),
  };
}

// Japanese sidebar labels: when a translated counterpart exists under docs/ja/,
// attach its title as a `translations.ja` entry so Starlight shows Japanese
// labels while browsing /ja/ pages. Pages without a translation keep the
// English label (and Starlight's locale fallback serves the English content).
function readJaCounterpartData(filePath) {
  const jaPath = join(docsTarget, "ja", relative(enDocsTarget, filePath));
  return existsSync(jaPath) ? readFrontmatter(jaPath) : undefined;
}

// Fallback Japanese labels for sidebar groups whose content is untranslated
// (no docs/ja/ README to pull a label from). Keeps the /ja/ sidebar uniformly
// Japanese at the top level even while those sections serve English fallback
// pages.
const jaGroupLabelFallbacks = {
  architecture: "アーキテクチャ",
  contributing: "コントリビュート",
};

function getJaGroupLabel(dirPath, dirName) {
  const jaReadmePath = getReadmePath(join(docsTarget, "ja", relative(enDocsTarget, dirPath)));
  if (!jaReadmePath) return dirName ? jaGroupLabelFallbacks[dirName.toLowerCase()] : undefined;
  const jaData = readFrontmatter(jaReadmePath);
  return jaData.sidebar?.groupLabel ?? jaData.groupLabel ?? jaData.title;
}

function buildDirectoryItems(dirPath, slugPrefix) {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  const readme = entries.find((entry) => isReadme(entry.name));
  const readmeNode = readme ? buildPageNode(join(dirPath, readme.name), slugPrefix) : undefined;
  const childNodes = entries
    .filter((entry) => !isReadme(entry.name))
    .flatMap((entry) => {
      const entryPath = join(dirPath, entry.name);
      if (entry.isDirectory()) return [buildGroupNode(entryPath, entry.name, joinSlug(slugPrefix, entry.name))];
      if (entry.isFile() && isMarkdownFile(entry.name)) {
        return [buildPageNode(entryPath, joinSlug(slugPrefix, stripMarkdownExtension(entry.name)))];
      }
      return [];
    })
    .filter(Boolean)
    .sort(compareNodes);

  return readmeNode && !readmeNode.hidden ? [readmeNode, ...childNodes] : childNodes;
}

function buildGroupNode(dirPath, dirName, slugPrefix) {
  const readmePath = getReadmePath(dirPath);
  const readmeData = readmePath ? readFrontmatter(readmePath) : {};
  const children = buildDirectoryItems(dirPath, slugPrefix);
  const childOrder = Math.min(...children.map((child) => child.order), maxOrder);

  const jaLabel = getJaGroupLabel(dirPath);

  return {
    item: {
      label: getGroupLabel(readmeData, dirName),
      collapsed: true,
      items: children.map((child) => child.item),
      ...(jaLabel ? { translations: { ja: jaLabel } } : {}),
    },
    order: readmeData.sidebar?.order ?? childOrder,
    sortKey: slugPrefix,
    hidden: false,
  };
}

function buildPageNode(filePath, slug) {
  const data = readFrontmatter(filePath);
  const jaData = readJaCounterpartData(filePath);
  const jaLabel = jaData?.sidebar?.label ?? jaData?.title;

  return {
    item: {
      label: data.sidebar?.label ?? data.title ?? prettySegmentLabel(basename(slug)),
      link: `/${slug}/`,
      ...(jaLabel ? { translations: { ja: jaLabel } } : {}),
    },
    order: data.sidebar?.order ?? maxOrder,
    sortKey: slug,
    hidden: data.sidebar?.hidden === true,
  };
}

function compareNodes(a, b) {
  if (a.order !== b.order) return a.order - b.order;
  return collator.compare(a.sortKey, b.sortKey);
}

function getGroupLabel(data, dirName) {
  return data.sidebar?.groupLabel ?? data.groupLabel ?? data.title ?? prettySegmentLabel(dirName);
}

function getReadmePath(dirPath) {
  for (const fileName of ["README.md", "README.mdx"]) {
    const filePath = join(dirPath, fileName);
    if (existsSync(filePath)) return filePath;
  }
  return undefined;
}

function readFrontmatter(filePath) {
  const content = readFileSync(filePath, "utf8");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};

  const data = {};
  let currentKey;

  for (const rawLine of match[1].split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;

    const nested = rawLine.match(/^ {2}([\w-]+):(?:\s*(.*))?$/);
    if (nested && currentKey) {
      data[currentKey] ??= {};
      data[currentKey][nested[1]] = parseFrontmatterValue(nested[2] ?? "");
      continue;
    }

    const topLevel = rawLine.match(/^([\w-]+):(?:\s*(.*))?$/);
    if (!topLevel) continue;

    const [, key, value = ""] = topLevel;
    if (value === "") {
      data[key] = {};
      currentKey = key;
    } else {
      data[key] = parseFrontmatterValue(value);
      currentKey = undefined;
    }
  }

  return data;
}

function parseFrontmatterValue(value) {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function prettySegmentLabel(segment) {
  const cleaned = segment.replace(/^\d+-/, (prefix) => `${Number.parseInt(prefix, 10)}: `);
  return cleaned
    .split("-")
    .map((word) => segmentLabelOverrides[word.toLowerCase()] ?? capitalize(word))
    .join(" ");
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function joinSlug(...parts) {
  return parts.filter(Boolean).join("/");
}

function isReadme(fileName) {
  return /^README\.mdx?$/i.test(fileName);
}

function isMarkdownFile(fileName) {
  return [".md", ".mdx"].includes(extname(fileName).toLowerCase());
}

function stripMarkdownExtension(fileName) {
  return fileName.replace(/\.mdx?$/i, "");
}

function buildTopLevelSidebar() {
  return readdirSync(enDocsTarget, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dirPath = resolve(enDocsTarget, entry.name);
      const readmePath = getReadmePath(dirPath);
      if (!readmePath) return [];

      const readmeData = readFrontmatter(readmePath);
      if (readmeData.sidebar?.hidden === true) return [];

      return [
        {
          item: buildSidebarSection(entry.name),
          order: readmeData.sidebar?.order ?? maxOrder,
          sortKey: entry.name,
        },
      ];
    })
    .sort(compareNodes)
    .map((node) => node.item);
}

const sidebar = buildTopLevelSidebar();

// Shared with the sitemap integration below. Registering our own sitemap makes Starlight skip its
// own, so the hreflang i18n block must be derived here from this same object or the two drift.
const docsLocales = {
  en: { label: "English", lang: "en" },
  ja: { label: "日本語", lang: "ja" },
} as const;

export default defineConfig({
  site: "https://docs.tomoribot.app",
  // Redirects for the /features/ restructure: the flat pages were bucketed into
  // task-based sub-category folders, changing their slugs. Keep the old URLs
  // (shared links, search-engine index) working by forwarding to the new paths.
  // Astro emits a static meta-refresh page for each key at build time.
  redirects: {
    "/": "/en/introduction/",
    "/en/": "/en/introduction/",
    "/ja/": "/ja/introduction/",
    "/architecture/entry-point/": "/en/architecture/entry-point/",
    "/architecture/integrations/discord/message-components-v2/": "/en/architecture/integrations/discord/message-components-v2/",
    "/architecture/integrations/discord/modal-input-components/": "/en/architecture/integrations/discord/modal-input-components/",
    "/architecture/integrations/matrix/bridge/": "/en/architecture/integrations/matrix/bridge/",
    "/architecture/integrations/novelai/inpainting/": "/en/architecture/integrations/novelai/inpainting/",
    "/architecture/integrations/novelai/limitations/": "/en/architecture/integrations/novelai/limitations/",
    "/architecture/integrations/novelai/tool-calling/": "/en/architecture/integrations/novelai/tool-calling/",
    "/architecture/integrations/sillytavern/card-support/": "/en/architecture/integrations/sillytavern/card-support/",
    "/architecture/integrations/sillytavern/preset-system/": "/en/architecture/integrations/sillytavern/preset-system/",
    "/architecture/pipelines/chat/01-normalize-invocation/": "/en/architecture/pipelines/chat/01-normalize-invocation/",
    "/architecture/pipelines/chat/02-evaluate-admission/": "/en/architecture/pipelines/chat/02-evaluate-admission/",
    "/architecture/pipelines/chat/03-handle-disposition/": "/en/architecture/pipelines/chat/03-handle-disposition/",
    "/architecture/pipelines/chat/04-channel-lock/": "/en/architecture/pipelines/chat/04-channel-lock/",
    "/architecture/pipelines/chat/05-plan-turns/": "/en/architecture/pipelines/chat/05-plan-turns/",
    "/architecture/pipelines/chat/06-per-turn/01-build-context/": "/en/architecture/pipelines/chat/06-per-turn/01-build-context/",
    "/architecture/pipelines/chat/06-per-turn/02-create-response-sink/": "/en/architecture/pipelines/chat/06-per-turn/02-create-response-sink/",
    "/architecture/pipelines/chat/06-per-turn/03-run-generation-turn/": "/en/architecture/pipelines/chat/06-per-turn/03-run-generation-turn/",
    "/architecture/pipelines/chat/06-per-turn/04-post-turn-effects/": "/en/architecture/pipelines/chat/06-per-turn/04-post-turn-effects/",
    "/architecture/pipelines/context-build/01-preset-routing/": "/en/architecture/pipelines/context-build/01-preset-routing/",
    "/architecture/pipelines/context-build/02-native-assembly/01-prompt-items/": "/en/architecture/pipelines/context-build/02-native-assembly/01-prompt-items/",
    "/architecture/pipelines/context-build/02-native-assembly/02-server-info/": "/en/architecture/pipelines/context-build/02-native-assembly/02-server-info/",
    "/architecture/pipelines/context-build/02-native-assembly/03-server-memories/": "/en/architecture/pipelines/context-build/02-native-assembly/03-server-memories/",
    "/architecture/pipelines/context-build/02-native-assembly/04-server-emojis/": "/en/architecture/pipelines/context-build/02-native-assembly/04-server-emojis/",
    "/architecture/pipelines/context-build/02-native-assembly/05-server-stickers/": "/en/architecture/pipelines/context-build/02-native-assembly/05-server-stickers/",
    "/architecture/pipelines/context-build/02-native-assembly/06-participants/": "/en/architecture/pipelines/context-build/02-native-assembly/06-participants/",
    "/architecture/pipelines/context-build/02-native-assembly/07-short-term-memory/": "/en/architecture/pipelines/context-build/02-native-assembly/07-short-term-memory/",
    "/architecture/pipelines/context-build/02-native-assembly/07b-verbatim-tool-definitions/": "/en/architecture/pipelines/context-build/02-native-assembly/07b-verbatim-tool-definitions/",
    "/architecture/pipelines/context-build/02-native-assembly/08-rag-documents/": "/en/architecture/pipelines/context-build/02-native-assembly/08-rag-documents/",
    "/architecture/pipelines/context-build/02-native-assembly/09-conditioning/": "/en/architecture/pipelines/context-build/02-native-assembly/09-conditioning/",
    "/architecture/pipelines/context-build/02-native-assembly/10-sample-dialogues/": "/en/architecture/pipelines/context-build/02-native-assembly/10-sample-dialogues/",
    "/architecture/pipelines/context-build/02-native-assembly/11-dialogue-history/": "/en/architecture/pipelines/context-build/02-native-assembly/11-dialogue-history/",
    "/architecture/pipelines/memory/ltm/01-ltm-create/": "/en/architecture/pipelines/memory/ltm/01-ltm-create/",
    "/architecture/pipelines/memory/ltm/02-ltm-update-delete/": "/en/architecture/pipelines/memory/ltm/02-ltm-update-delete/",
    "/architecture/pipelines/memory/stm/01-passive-capture/": "/en/architecture/pipelines/memory/stm/01-passive-capture/",
    "/architecture/pipelines/memory/stm/02-summary-upgrade/": "/en/architecture/pipelines/memory/stm/02-summary-upgrade/",
    "/architecture/pipelines/provider/01-context-assembly/": "/en/architecture/pipelines/provider/01-context-assembly/",
    "/architecture/pipelines/provider/02-raw-chunk-generation/": "/en/architecture/pipelines/provider/02-raw-chunk-generation/",
    "/architecture/pipelines/provider/03-chunk-normalization/": "/en/architecture/pipelines/provider/03-chunk-normalization/",
    "/architecture/pipelines/provider/04-orchestrator-state-machine/": "/en/architecture/pipelines/provider/04-orchestrator-state-machine/",
    "/architecture/pipelines/provider/05-buffer-management/": "/en/architecture/pipelines/provider/05-buffer-management/",
    "/architecture/pipelines/provider/06-segment-normalization/": "/en/architecture/pipelines/provider/06-segment-normalization/",
    "/architecture/pipelines/provider/07-discord-delivery/": "/en/architecture/pipelines/provider/07-discord-delivery/",
    "/architecture/pipelines/tool-loop/01-stream-once/": "/en/architecture/pipelines/tool-loop/01-stream-once/",
    "/architecture/pipelines/tool-loop/02-execute-tool-call/": "/en/architecture/pipelines/tool-loop/02-execute-tool-call/",
    "/architecture/pipelines/tool-loop/03-enhanced-context-restart/": "/en/architecture/pipelines/tool-loop/03-enhanced-context-restart/",
    "/architecture/pipelines/tool-loop/04-build-result/": "/en/architecture/pipelines/tool-loop/04-build-result/",
    "/architecture/subsystems/caching/": "/en/architecture/subsystems/caching/",
    "/architecture/subsystems/command-system/": "/en/architecture/subsystems/command-system/",
    "/architecture/subsystems/cooldowns/": "/en/architecture/subsystems/cooldowns/",
    "/architecture/subsystems/database-schema/": "/en/architecture/subsystems/database-schema/",
    "/architecture/subsystems/event-system/": "/en/architecture/subsystems/event-system/",
    "/architecture/subsystems/localization/": "/en/architecture/subsystems/localization/",
    "/architecture/subsystems/logit-bias/": "/en/architecture/subsystems/logit-bias/",
    "/architecture/subsystems/multi-persona/": "/en/architecture/subsystems/multi-persona/",
    "/architecture/subsystems/persona-presets/": "/en/architecture/subsystems/persona-presets/",
    "/architecture/subsystems/prompt-snapshot/": "/en/architecture/subsystems/prompt-snapshot/",
    "/architecture/subsystems/security/": "/en/architecture/subsystems/security/",
    "/architecture/subsystems/stats-infographic/": "/en/architecture/subsystems/stats-infographic/",
    "/architecture/subsystems/status-command/": "/en/architecture/subsystems/status-command/",
    "/architecture/subsystems/strict-chat-completion/": "/en/architecture/subsystems/strict-chat-completion/",
    "/architecture/subsystems/thinking-level/": "/en/architecture/subsystems/thinking-level/",
    "/architecture/subsystems/tool-system/": "/en/architecture/subsystems/tool-system/",
    "/architecture/subsystems/utils/": "/en/architecture/subsystems/utils/",
    "/architecture/subsystems/video-generation/": "/en/architecture/subsystems/video-generation/",
    "/contributing/adding-builtin-tool/": "/en/contributing/adding-builtin-tool/",
    "/contributing/adding-db-column/": "/en/contributing/adding-db-column/",
    "/contributing/adding-event-handler/": "/en/contributing/adding-event-handler/",
    "/contributing/adding-feature-flag-tool/": "/en/contributing/adding-feature-flag-tool/",
    "/contributing/adding-locale/": "/en/contributing/adding-locale/",
    "/contributing/adding-new-provider/": "/en/contributing/adding-new-provider/",
    "/contributing/adding-participant-extension/": "/en/contributing/adding-participant-extension/",
    "/contributing/adding-persona-preset/": "/en/contributing/adding-persona-preset/",
    "/contributing/adding-setup-module/": "/en/contributing/adding-setup-module/",
    "/contributing/adding-slash-command/": "/en/contributing/adding-slash-command/",
    "/contributing/comment-policy/": "/en/contributing/comment-policy/",
    "/contributing/dependency-security-policy/": "/en/contributing/dependency-security-policy/",
    "/contributing/development-tasks/": "/en/contributing/development-tasks/",
    "/contributing/docs-authoring/": "/en/contributing/docs-authoring/",
    "/contributing/getting-started/": "/en/contributing/getting-started/",
    "/contributing/raw-sql-boundary/": "/en/contributing/raw-sql-boundary/",
    "/contributing/testing-chat-changes/": "/en/contributing/testing-chat-changes/",
    "/contributing/testing-db-changes/": "/en/contributing/testing-db-changes/",
    "/contributing/testing-module-mocks/": "/en/contributing/testing-module-mocks/",
    "/features/command-reference/": "/en/features/command-reference/",
    "/features/capabilities/scheduled-tasks/": "/en/features/capabilities/scheduled-tasks/",
    "/features/capabilities/tools-and-extensions/": "/en/features/capabilities/tools-and-extensions/",
    "/features/capabilities/media-generation/image-generation/": "/en/features/capabilities/media-generation/image-generation/",
    "/features/capabilities/media-generation/tts-and-stt/": "/en/features/capabilities/media-generation/tts-and-stt/",
    "/features/capabilities/media-generation/video-generation/": "/en/features/capabilities/media-generation/video-generation/",
    "/features/chatting-personality/behavior-tweaking/": "/en/features/chatting-personality/behavior-tweaking/",
    "/features/chatting-personality/chatting-and-triggers/": "/en/features/chatting-personality/chatting-and-triggers/",
    "/features/chatting-personality/multiple-personas/": "/en/features/chatting-personality/multiple-personas/",
    "/features/integrations/matrix-bridge/": "/en/features/integrations/matrix-bridge/",
    "/features/integrations/sillytavern-support/": "/en/features/integrations/sillytavern-support/",
    "/features/knowledge/data-handling/": "/en/features/knowledge/data-handling/",
    "/features/knowledge/memory/": "/en/features/knowledge/memory/",
    "/features/knowledge/personalization/": "/en/features/knowledge/personalization/",
    "/features/setup-administration/age-restricted-commands/": "/en/features/setup-administration/age-restricted-commands/",
    "/features/setup-administration/providers-and-models/": "/en/features/setup-administration/providers-and-models/",
    "/features/setup-administration/server-moderation/": "/en/features/setup-administration/server-moderation/",
    "/features/setup-administration/stats-and-insights/": "/en/features/setup-administration/stats-and-insights/",
    "/legal/privacy-policy/": "/en/legal/privacy-policy/",
    "/legal/terms-of-service/": "/en/legal/terms-of-service/",
    "/meet-tomori/aphel/": "/en/meet-tomori/aphel/",
    "/meet-tomori/lilya/": "/en/meet-tomori/lilya/",
    "/meet-tomori/locke/": "/en/meet-tomori/locke/",
    "/meet-tomori/nerine/": "/en/meet-tomori/nerine/",
    "/meet-tomori/rose/": "/en/meet-tomori/rose/",
    "/meet-tomori/zaya/": "/en/meet-tomori/zaya/",
    "/self-hosting/docker-compose/": "/en/self-hosting/docker-compose/",
    "/self-hosting/local-monitoring/": "/en/self-hosting/local-monitoring/",
    "/self-hosting/maintenance/": "/en/self-hosting/maintenance/",
    "/self-hosting/manual-setup/": "/en/self-hosting/manual-setup/",
    "/self-hosting/safe-migration/": "/en/self-hosting/safe-migration/",
    "/self-hosting/setup-wizard/": "/en/self-hosting/setup-wizard/",
    "/self-hosting/local-endpoints/setup-chatmock/": "/en/self-hosting/local-endpoints/setup-chatmock/",
    "/self-hosting/local-endpoints/setup-comfyui/": "/en/self-hosting/local-endpoints/setup-comfyui/",
    "/self-hosting/local-endpoints/setup-crawl4ai/": "/en/self-hosting/local-endpoints/setup-crawl4ai/",
    "/self-hosting/local-endpoints/setup-local-llm/": "/en/self-hosting/local-endpoints/setup-local-llm/",
    "/self-hosting/local-endpoints/setup-local-mcp/": "/en/self-hosting/local-endpoints/setup-local-mcp/",
    "/self-hosting/local-endpoints/setup-searxng/": "/en/self-hosting/local-endpoints/setup-searxng/",
    "/self-hosting/local-endpoints/speech-to-text/koboldcpp/": "/en/self-hosting/local-endpoints/speech-to-text/koboldcpp/",
    "/self-hosting/local-endpoints/speech-to-text/whispercpp/": "/en/self-hosting/local-endpoints/speech-to-text/whispercpp/",
    "/self-hosting/local-endpoints/speech-to-text/whisperx/": "/en/self-hosting/local-endpoints/speech-to-text/whisperx/",
    "/self-hosting/local-endpoints/text-to-speech/chatterbox/": "/en/self-hosting/local-endpoints/text-to-speech/chatterbox/",
    "/self-hosting/local-endpoints/text-to-speech/irodoritts/": "/en/self-hosting/local-endpoints/text-to-speech/irodoritts/",
    "/self-hosting/local-endpoints/text-to-speech/qwen3tts/": "/en/self-hosting/local-endpoints/text-to-speech/qwen3tts/",
    "/wiki/refactor-record/": "/en/wiki/refactor-record/",
    "/wiki/threat-models/": "/en/wiki/threat-models/",
    "/introduction/quickstart/": "/en/introduction/quickstart/",
    "/features/chatting-and-triggers": "/en/features/chatting-personality/chatting-and-triggers/",
    "/features/multiple-personas": "/en/features/chatting-personality/multiple-personas/",
    "/features/behavior-tweaking": "/en/features/chatting-personality/behavior-tweaking/",
    "/features/memory": "/en/features/knowledge/memory/",
    "/features/personalization": "/en/features/knowledge/personalization/",
    "/features/data-handling": "/en/features/knowledge/data-handling/",
    "/features/tools-and-extensions": "/en/features/capabilities/tools-and-extensions/",
    "/features/scheduled-tasks": "/en/features/capabilities/scheduled-tasks/",
    "/features/media-generation": "/en/features/capabilities/media-generation/",
    "/features/media-generation/image-generation": "/en/features/capabilities/media-generation/image-generation/",
    "/features/media-generation/video-generation": "/en/features/capabilities/media-generation/video-generation/",
    "/features/media-generation/tts-and-stt": "/en/features/capabilities/media-generation/tts-and-stt/",
    "/features/providers-and-models": "/en/features/setup-administration/providers-and-models/",
    "/features/server-moderation": "/en/features/setup-administration/server-moderation/",
    "/features/age-restricted-commands": "/en/features/setup-administration/age-restricted-commands/",
    "/features/stats-and-insights": "/en/features/setup-administration/stats-and-insights/",
    "/features/matrix-bridge": "/en/features/integrations/matrix-bridge/",
    "/features/sillytavern-support": "/en/features/integrations/sillytavern-support/",
  },

  // Docs content lives at repo-root `docs/`, surfaced via a junction at `src/content/docs`
  // (see above). Vite resolves each content file to its real path under `../../docs/...`,
  // which sits outside this app, so a bare `@astrojs/starlight/components` import in an MDX
  // page resolves from repo-root node_modules and fails (Starlight is installed only under
  // `apps/docs/node_modules`). Alias that one package subpath to its concrete location so
  // MDX landing pages can use Starlight's <Card>/<LinkCard>/<LinkButton>. A global
  // `resolve.preserveSymlinks` would fix this too but breaks Bun's `.bun/` symlink store.
  vite: {
    resolve: {
      // Exact-match regex (not a string prefix) so ONLY the bare specifier is rewritten —
      // Starlight resolves its own `@astrojs/starlight/components/Banner.astro` subpaths
      // internally and must not be touched.
      alias: [
        {
          find: /^@astrojs\/starlight\/components$/,
          replacement: resolve(__dirname, "node_modules/@astrojs/starlight/components.ts"),
        },
      ],
    },
  },
  integrations: [
    // Before starlight so it detects this one and skips adding its own. A `noindex` URL left in the
    // sitemap makes Search Console report "Submitted URL marked 'noindex'", hence the wiki filter.
    sitemap({
      i18n: {
        defaultLocale: "en",
        locales: Object.fromEntries(Object.entries(docsLocales).map(([locale, { lang }]) => [locale, lang])),
      },
      filter: (page) => !/\/wiki(\/|$)/.test(new URL(page).pathname),
    }),
    starlight({
      title: "TomoriBot",
      // i18n: `en` handles /en/ pages, and Starlight handles root redirection automatically.
      // Japanese pages live under docs/ja/ mirroring the English tree; untranslated pages fall back to English
      // content served at the /ja/ URL with a translation notice.
      defaultLocale: "en",
      locales: docsLocales,
      // Fallback meta description for pages without one (see routeMiddleware
      // below, which auto-derives per-page descriptions from page content).
      description:
        "Documentation for TomoriBot, a self-hostable AI Discord bot with persistent memory, multiple personas, media generation, and multi-provider LLM support.",
      plugins: [
        starlightLlmsTxt({
          details:
            "AI agents should begin with the [Introduction](https://docs.tomoribot.app/en/introduction/) and [Features](https://docs.tomoribot.app/en/features/) indexes. For a specific question, fetch the smallest relevant page instead of a combined documentation set; common starting points are [Tools & Extensions](https://docs.tomoribot.app/en/features/capabilities/tools-and-extensions/), [Memory](https://docs.tomoribot.app/en/features/knowledge/memory/), [Inside the Prompt](https://docs.tomoribot.app/en/features/knowledge/inside-the-prompt/), and [Providers & Models](https://docs.tomoribot.app/en/features/setup-administration/providers-and-models/). Current runtime capability reports and assembled context override general documentation. Contributor, architecture, self-hosting, and other public pages remain available for deeper investigation. Internal wiki pages are intentionally omitted from every machine-readable documentation set.",
          exclude: ["ja/**", "en/wiki", "en/wiki/**", "en/architecture/**", "en/contributing/**", "en/self-hosting/**", "en/meet-tomori/**", "en/legal/**"],
          excludeFull: ["en/wiki", "en/wiki/**", "ja/wiki", "ja/wiki/**"],
          promote: ["en/introduction/**", "en/features/**"],
          demote: ["en/architecture/**", "en/contributing/**"],
          customSets: [
            {
              label: "TomoriBot introduction and features",
              description: "the emphasized, user-facing self-knowledge source for TomoriBot",
              paths: ["en/introduction/**", "en/features/**"],
            },
            {
              label: "Self-hosting and public reference",
              description: "secondary deployment, project, and legal documentation",
              paths: ["en/self-hosting/**", "en/meet-tomori/**", "en/legal/**"],
            },
            {
              label: "Contributor and architecture documentation",
              description: "developer implementation guides and code-level architecture references for TomoriBot",
              paths: ["en/contributing/**", "en/architecture/**"],
            },
          ],
        }),
      ],
      // SEO head tags: auto-derives per-page meta descriptions from each
      // page's first paragraph and noindexes internal wiki/ pages.
      routeMiddleware: "./src/routeData.ts",
      // Served from apps/docs/public/favicon.ico at the site root as /favicon.ico.
      favicon: "/favicon.ico",
      head: [
        {
          // 1200×630 social banner (Open Graph standard size). Served from
          // apps/docs/public/img/social-banner.png.
          tag: "meta",
          attrs: { property: "og:image", content: "https://docs.tomoribot.app/img/social-banner.png" },
        },
        {
          tag: "meta",
          attrs: { property: "og:image:width", content: "1200" },
        },
        {
          tag: "meta",
          attrs: { property: "og:image:height", content: "630" },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image:alt",
            content: "TomoriBot | Open-Source AI Agent & Roleplay Bot for Discord",
          },
        },
        {
          // Large-image card: the og:image is a proper 1200×630 banner now,
          // so the stretched-square concern no longer applies.
          tag: "meta",
          attrs: { name: "twitter:card", content: "summary_large_image" },
        },
        {
          tag: "link",
          attrs: { rel: "icon", type: "image/x-icon", href: "/favicon.ico", sizes: "any" },
        },
        {
          // Browsers that support SVG favicons (Chrome, Firefox) prefer this over the
          // PNG/ICO fallbacks below, so it must come first in document order.
          tag: "link",
          attrs: { rel: "icon", type: "image/svg+xml", href: "/tomoricon.svg" },
        },
        {
          tag: "link",
          attrs: { rel: "icon", type: "image/png", href: "/tomoricon.png" },
        },
        {
          // iOS ignores SVG apple-touch-icons, so this must stay a raster PNG.
          tag: "link",
          attrs: { rel: "apple-touch-icon", href: "/tomoricon.png" },
        },
      ],
      customCss: ["/src/styles/custom.css"],
      // SiteTitle override renders /tomoricon.svg directly as a plain <img> in the nav header.
      // The standard `logo` config can't reference public/ files because it generates a Vite
      // import that expects an Astro image object { src, width, height }, not a URL string.
      components: {
        SiteTitle: "./src/components/SiteTitle.astro",
        // Prepends the "AI-generated" disclaimer note to every page.
        // Opt out per-page with `aiGenerated: false` in frontmatter.
        MarkdownContent: "./src/components/MarkdownContent.astro",
        // Resolves prev/next pager labels to each target page's real title, so
        // generic "Overview" sidebar labels don't leak into footer navigation.
        Pagination: "./src/components/Pagination.astro",
        // Appends a Ko-fi support link beside the GitHub icon in the header,
        // since Ko-fi isn't part of Starlight's built-in social icon set.
        SocialIcons: "./src/components/SocialIcons.astro",
      },
      // Starlight v0.33.0+ expects an array of link items instead of a keyed object.
      // Discord uses a built-in Starlight icon; Ko-fi is appended separately in the
      // SocialIcons override since it isn't part of Starlight's fixed icon set.
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/Bredrumb/TomoriBot" },
        { icon: "discord", label: "Discord", href: "https://discord.gg/bjCfHm9QsB" },
      ],
      sidebar,
    }),
  ],
});


