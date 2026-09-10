export default {
  import: {
    description: "Import configuration or memories from a portable file.",
    config: {
      description: "Import a server configuration file.",
      file_description: "The configuration file exported by TomoriBot.",
    },
    memories: {
      description: "Import a server memory file.",
      file_description: "The memory file exported by TomoriBot.",
    },
    personal: {
      description: "Import the configuration or memories your account owns.",
      config: {
        description: "Import a personal configuration file.",
        file_description: "The personal configuration file exported by TomoriBot.",
      },
      memories: {
        description: "Import a personal memory file.",
        file_description: "The personal memory file exported by TomoriBot.",
      },
    },
  },
};
