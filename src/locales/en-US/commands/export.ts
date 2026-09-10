export default {
  export: {
    description: "Export your configuration or memories as a portable file.",
    config: {
      description: "Export this server configuration as a portable file.",
    },
    memories: {
      description: "Export memories as a portable file.",
      scope_description: "Which memories to export.",
      persona_description: "The persona to export memories for. Only used by the Selected Persona scope.",
      scope_choice_main: "Main Persona",
      scope_choice_persona: "Selected Persona",
      scope_choice_all: "All Personas",
    },
    personal: {
      description: "Export the configuration or memories your account owns.",
      config: {
        description: "Export your personal configuration as a portable file.",
      },
      memories: {
        description: "Export the memories your account owns as a portable file.",
        scope_description: "Which of your memories to export.",
        persona_description: "The persona to export memories for. Only used by the Selected Persona scope.",
        scope_choice_global: "Global",
        scope_choice_persona: "Selected Persona",
        scope_choice_all: "All Personas",
      },
    },
  },
};
