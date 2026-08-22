export default {
  quota: {
    description: `Manage generation quota resets.`,
    reset: {
      description: `Reset a quota pool for image, text, or video generation.`,
      user: {
        description: `Reset daily quota usage for a user.`,
        member_description: `The member whose daily quota should be reset.`,
        quota_type_description: `Choose which quota pool type to reset.`,
        image_option: `Image Generation`,
        text_option: `Text Generation`,
        video_option: `Video Generation`,
        success_title: `Quota Reset`,
        success_image_description: `Reset daily image generation quota usage for {user}.`,
        success_text_description: `Reset daily text generation trigger quota usage for {user}.`,
        success_video_description: `Reset daily video generation quota usage for {user}.`,
      },
      global: {
        description: `Reset the server-wide generation quota pool.`,
        quota_type_description: `Choose which quota pool type to reset.`,
        image_option: `Image Generation`,
        text_option: `Text Generation`,
        video_option: `Video Generation`,
        success_title: `Quota Reset`,
        success_image_description: `Reset the server-wide image generation quota pool.`,
        success_text_description: `Reset the server-wide text generation trigger quota pool.`,
        success_video_description: `Reset the server-wide video generation quota pool.`,
      },
    },
  },
};
