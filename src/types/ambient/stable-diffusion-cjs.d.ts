declare module "stable-diffusion-cjs" {
	export function generate(prompt: string): Promise<Buffer>;
}
