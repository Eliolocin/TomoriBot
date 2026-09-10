export default {
  import: {
    description: "Import configuration from a portable file.",
    config: {
      description: "Import a workspace configuration file.",
      file_description: "The configuration file exported by TomoriBot.",
    },
    personal: {
      description: "Import the configuration your account owns.",
      config: {
        description: "Import a personal configuration file.",
        file_description: "The personal configuration file exported by TomoriBot.",
      },
    },
  },
};
