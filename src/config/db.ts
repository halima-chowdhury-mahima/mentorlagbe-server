
import { Db, MongoClient } from "mongodb";

let client: MongoClient | null = null;
let database: Db | null = null;
let connectionPromise: Promise<void> | null = null;

export const connectDB = async (): Promise<void> => {
  if (database) {
    return;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = (async () => {
    try {
      const uri = process.env.MONGODB_URI;

      if (!uri) {
        throw new Error("MONGODB_URI is missing.");
      }

      if (!client) {
        client = new MongoClient(uri);
      }

      await client.connect();

      const db = client.db("mentorlagbe");

      await db.command({ ping: 1 });

      database = db;

      console.log("MongoDB Connected Successfully!");
      console.log("Database: mentorlagbe");
    } catch (error) {
      console.error("MongoDB Connection Failed:", error);

      if (client) {
        await client.close().catch(() => undefined);
      }

      client = null;
      database = null;

      throw error;
    } finally {
      connectionPromise = null;
    }
  })();

  return connectionPromise;
};

export const getDB = (): Db => {
  if (!database) {
    throw new Error("Database is not connected yet!");
  }

  return database;
};
