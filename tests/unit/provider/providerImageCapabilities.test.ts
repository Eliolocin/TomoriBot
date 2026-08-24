import { describe, expect, it } from "bun:test";
import {
  curatedImageSupportsFromSubmittedValues,
  getCuratedProviderImageDefaults,
  resolveCuratedImageSupports,
} from "@/utils/provider/providerImageCapabilities";

describe("curated provider image capabilities", () => {
  it("starts every curated provider with inpainting and negative prompts off", () => {
    for (const provider of ["google", "openrouter", "vertex", "vertexexpress"]) {
      expect(getCuratedProviderImageDefaults(provider)).toEqual({
        txt2img: true,
        img2img: true,
        inpaint: false,
        negative_prompt: false,
      });
    }
    for (const provider of ["zai", "nvidia"]) {
      expect(getCuratedProviderImageDefaults(provider)).toEqual({
        txt2img: true,
        img2img: false,
        inpaint: false,
        negative_prompt: false,
      });
    }
  });

  it("declines to declare capabilities for providers whose image path ignores them", () => {
    // NovelAI generates images through its own tool, so a declaration here would do nothing.
    expect(getCuratedProviderImageDefaults("novelai")).toBeNull();
    expect(getCuratedProviderImageDefaults("anthropic")).toBeNull();
    expect(resolveCuratedImageSupports("novelai", null)).toBeNull();
    expect(curatedImageSupportsFromSubmittedValues(["inpaint"], "novelai")).toBeNull();
  });

  it("layers declarations over provider defaults one field at a time", () => {
    expect(
      resolveCuratedImageSupports("google", {
        supports_inpaint: true,
        supports_txt2img: null,
        supports_img2img: null,
        supports_negative_prompt: null,
      }),
    ).toEqual({ txt2img: true, img2img: true, inpaint: true, negative_prompt: false });

    // An explicit false must survive, not fall back to the provider default.
    expect(
      resolveCuratedImageSupports("google", {
        supports_img2img: false,
        supports_txt2img: null,
        supports_inpaint: null,
        supports_negative_prompt: null,
      }),
    ).toEqual({ txt2img: true, img2img: false, inpaint: false, negative_prompt: false });

    expect(resolveCuratedImageSupports("nvidia", null)).toEqual({
      txt2img: true,
      img2img: false,
      inpaint: false,
      negative_prompt: false,
    });
  });

  it("honours a submitted inpaint declaration that the endpoint parser would discard", () => {
    expect(curatedImageSupportsFromSubmittedValues(["txt2img", "inpaint"], "google")).toEqual({
      txt2img: true,
      img2img: false,
      inpaint: true,
      negative_prompt: false,
    });
    // Selecting no generation mode still leaves text-to-image usable.
    expect(curatedImageSupportsFromSubmittedValues(["negative_prompt"], "google")).toEqual({
      txt2img: true,
      img2img: false,
      inpaint: false,
      negative_prompt: true,
    });
  });
});
