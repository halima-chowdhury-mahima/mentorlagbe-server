
import { Db, MongoClient } from "mongodb";

let client: MongoClient;
let database: Db;

export const connectDB = async (): Promise<void> => {
  try {
    const uri = process.env.MONGODB_URI;

    if (!uri) {
      throw new Error("MONGODB_URI is missing in .env file");
    }

    client = new MongoClient(uri);

    await client.connect();

    database = client.db("mentorlagbe");

    await database.command({ ping: 1 });

    console.log("MongoDB Connected Successfully!");
    console.log("Database: mentorlagbe");
  } catch (error) {
    console.error("MongoDB Connection Failed:", error);
    process.exit(1);
  }
};

export const getDB = (): Db => {
  if (!database) {
    throw new Error("Database is not connected yet!");
  }

  return database;
};
