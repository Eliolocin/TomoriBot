import dotenv from "dotenv";
import mongoose from "mongoose";
import BotModel from "../src/models/botSchema";
import UserModel from "../src/models/userSchema";
import ShopModel from "../src/models/shopSchema";
import { IBot, IUser, IShop } from "../src/types/global";

dotenv.config();

async function purgeCollection<T>(
  model: mongoose.Model<mongoose.Document<unknown, {}, T>>,
  modelName: string
) {
  try {
    const result = await model.deleteMany({});
    console.log(`${modelName}: Deleted ${result.deletedCount} documents`);
    return { deleted: result.deletedCount };
  } catch (err) {
    console.error(`Error purging ${modelName}:`, err);
    return { error: (err as Error).message };
  }
}

async function purgeDatabase() {
  try {
    await mongoose.connect(process.env.MONGODB_SRV as string);
    console.log("::group::Database Purge Summary");

    const results = await Promise.all([
      purgeCollection<IBot>(BotModel, "Bots"),
      purgeCollection<IUser>(UserModel, "Users"),
      purgeCollection<IShop>(ShopModel, "Shops"),
    ]);

    let hasErrors = false;
    results.forEach((result, index) => {
      const collection = ["Bots", "Users", "Shops"][index];
      if ('error' in result) {
        console.log(`::error::${collection}: ${result.error}`);
        hasErrors = true;
      } else {
        console.log(`${collection}: ${result.deleted} documents deleted`);
      }
    });

    console.log("::endgroup::");

    if (hasErrors) {
      throw new Error("One or more collections failed to purge");
    }
  } catch (err) {
    console.error("::error::Database purge failed:", err);
    process.exit(1);
  } finally {
    try {
      await mongoose.disconnect();
    } catch {
      // Ignore disconnect errors since the operation was successful
      console.log("Note: Database operations completed successfully before disconnect");
    }
  }
}

// Run if called directly (not imported)
if (require.main === module) {
  purgeDatabase().then(() => process.exit(0));
}

export default purgeDatabase;

/*
Usage:
bun run scripts/purgeDb.ts

or add to package.json:
"scripts": {
  "db-purge": "bun run scripts/purgeDb.ts"
}

WARNING: This script will delete ALL data from the database. Use with caution!
*/