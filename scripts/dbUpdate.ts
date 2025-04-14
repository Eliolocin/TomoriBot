import dotenv from "dotenv";
import mongoose, { Document } from "mongoose";
import BotModel from "../src/models/botSchema";
import UserModel from "../src/models/userSchema";
import ShopModel from "../src/models/shopSchema";
import { IBot, IUser, IShop } from "../src/types/global";

dotenv.config();

type DocumentType<T> = T & Document;

async function updateCollection<T>(
  model: mongoose.Model<DocumentType<T>>,
  modelName: string
) {
  try {
    // Find all documents
    const documents = await model.find({});
    let updated = 0;

    // Update each document
    for (const doc of documents) {
      const originalDoc = { ...doc.toObject() };
      // Save document to trigger Mongoose defaults
      await doc.save();

      // Check if document was modified
      if (JSON.stringify(originalDoc) !== JSON.stringify(doc.toObject())) {
        updated++;
      }
    }

    console.log(
      `${modelName}: Updated ${updated}/${documents.length} documents`,
    );
    return { total: documents.length, updated };
  } catch (err) {
    console.error(`Error updating ${modelName}:`, err);
    return { error: (err as Error).message };
  }
}

async function updateDatabase() {
  try {
    await mongoose.connect(process.env.MONGODB_SRV as string);
    console.log("::group::Database Update Summary");

    const results = await Promise.all([
      updateCollection<IBot>(BotModel as mongoose.Model<DocumentType<IBot>>, "Bots"),
      updateCollection<IUser>(UserModel as mongoose.Model<DocumentType<IUser>>, "Users"),
      updateCollection<IShop>(ShopModel as mongoose.Model<DocumentType<IShop>>, "Shops"),
    ]);

    let hasErrors = false;
    results.forEach((result, index) => {
      const collection = ["Bots", "Users", "Shops"][index];
      if ('error' in result) {
        console.log(`::error::${collection}: ${result.error}`);
        hasErrors = true;
      } else {
        console.log(
          `${collection}: ${result.updated} of ${result.total} documents updated`,
        );
      }
    });

    console.log("::endgroup::");

    if (hasErrors) {
      throw new Error("One or more collections failed to update");
    }
  } catch (err) {
    console.error("::error::Database update failed:", err);
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
  updateDatabase().then(() => process.exit(0));
}

export default updateDatabase;

/*
Usage:
bun run scripts/dbUpdate.ts
or
npm run db-update

CI/CD Integration:
Add the following script to your package.json file:
"scripts": {
  "db-update": "bun run scripts/dbUpdate.ts"
}
Then, you can run the script using npm run db-update.

name: Database Schema Update

on:
  push:
    paths:
      - 'models/*.ts'
    branches:
      - main

jobs:
  update-db:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '16'
      - run: npm install
      - name: Update Database Schemas
        run: npm run db-update
        env:
          MONGODB_SRV: ${{ secrets.MONGODB_SRV }}
*/