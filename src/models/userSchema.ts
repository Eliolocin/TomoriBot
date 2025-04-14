import mongoose, { model, Schema } from "mongoose";
import { IUser } from "../types/global";

// Define the schema for the user
const userSchema = new Schema<IUser>({
	userID: { type: String, required: true, unique: true },
	serverID: { type: String, required: true },
	nickname: { type: String, required: true },
	level: { type: Number, default: 1 },
	xp: { type: Number, default: 0 },
	coins: { type: Number, default: 1000 },
	bank: { type: Number, default: 0 },
	inventory: [
		{
			itemID: { type: String, required: true },
			name: { type: String, required: true },
			quantity: { type: Number, required: true },
			description: { type: String },
		},
	],
	language: { type: String, default: "en" },
	conversationExamples: [
		{
			input: { type: String, required: true },
			output: { type: String, required: true },
		},
	],
	botDatabase: { type: [String], default: [] },
	isPersonalized: { type: Boolean, default: false },
	cooldowns: { type: Map, of: Schema.Types.Mixed, default: {} },
	counters: { type: [Number], default: [] },
});

// Ensure model doesn't get registered multiple times
const UserModel = mongoose.models.users || model<IUser>("users", userSchema);
export default UserModel;
