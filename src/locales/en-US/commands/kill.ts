export default {
  kill: {
    description: `Immediately stop the current stream and clear queued responses in this channel.`,
    success_title: `Stream Stopped`,
    success_description: `Stopped the active response stream (if any) and cleared queued responses in this channel.`,
    nothing_to_stop_title: `Nothing to Stop`,
    nothing_to_stop_description: `There is no active response stream or queued response to clear in this channel.`,
  },
};
