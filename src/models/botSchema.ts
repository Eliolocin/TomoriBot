import mongoose, { model, Schema } from "mongoose";
import { IBot } from "../types/global";

const botSchema = new Schema<IBot>({
  serverID: { type: String, required: true, unique: true },
  botName: { type: String, required: true, default: "TomoBot" },
  conversationExamples: [
    {
      input: { type: String, required: true },
      output: { type: String, required: true },
    },
  ],
  botPersonality: { type: String, required: true, default: "" },
  botDatabase: { type: [String], default: [] },
  settings: [{
    key: { type: String, required: true },
    value: { type: String, required: true },
    description: { type: String, required: true },
  }],
  triggers: {
    type: [String],
    default: ["tomo", "tomobot", process.env.TOMO_ID, "トモ", "とも"],
  },
  counters: { type: [Number], default: [] },
});

// Ensure model doesn't get registered multiple times
const BotModel = mongoose.models.bots || model<IBot>("bots", botSchema);
export default BotModel;
