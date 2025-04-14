import mongoose, { model, Schema } from "mongoose";
import { IShop } from "../types/global";

const shopSchema = new Schema<IShop>({
	serverID: { type: String, required: true },
	shopName: { type: String, default: "Server Shop" },
	currency: { type: String, default: "TomoCoins" },
	items: [
		{
			itemID: { type: String, required: true, unique: true },
			name: { type: String, required: true },
			price: { type: Number, required: true },
			quantityAvailable: { type: Number, default: 0 },
			description: { type: String },
			attributes: [
				{
					key: { type: String, required: true },
					value: { type: Schema.Types.Mixed, required: true },
				},
			],
		},
	],
	transactionLog: [
		{
			userID: { type: String, required: true },
			itemID: { type: String, required: true },
			quantity: { type: Number, required: true },
			totalCost: { type: Number, required: true },
			date: { type: Date, default: Date.now },
		},
	],
});

// Ensure model doesn't get registered multiple times
const ShopModel = mongoose.models.shops || model<IShop>("shops", shopSchema);
export default ShopModel;
