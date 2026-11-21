import "dotenv/config";
import { connectDB } from "../config/db.js";
import { getCollections } from "../config/collections.js";

// Only target old active tuition records that have never received
// an approvalStatus field.
const LEGACY_FILTER = {
  approvalStatus: { $exists: false },
  status: "active",
};

const EXPECTED_COUNT = 8;

async function migrateLegacyTuitions(): Promise<void> {
  console.log("\n======================================");
  console.log(" MentorLagbe Tuition Migration");
  console.log("======================================\n");

  // Connect to MongoDB.
  await connectDB();

  const { tuitions } = await getCollections();

  // Count matching legacy records.
  const total = await tuitions.countDocuments(LEGACY_FILTER);

  console.log(`Matching legacy records: ${total}`);

  // Show the records before making any changes.
  const records = await tuitions
    .find(LEGACY_FILTER)
    .project({
      _id: 1,
      title: 1,
      status: 1,
      approvalStatus: 1,
    })
    .toArray();

  console.log("\nRecords found:");

  for (const record of records) {
    console.log({
      id: record._id.toString(),
      title: record.title ?? "Untitled",
      currentStatus: record.status ?? "Not set",
      approvalStatus: record.approvalStatus ?? "Not set",
    });
  }

  // Dry run is the default. No database changes happen without --apply.
  const shouldApply = process.argv.includes("--apply");

  if (!shouldApply) {
    console.log("\nDRY RUN COMPLETE");
    console.log("No database records were changed.");
    console.log(
      "\nIf these are the correct 8 records, run the command with --apply."
    );
    return;
  }

  // Safety check: do not update if the count is not exactly 8.
  if (total !== EXPECTED_COUNT) {
    throw new Error(
      `Migration stopped: expected exactly ${EXPECTED_COUNT} records, but found ${total}. No records were updated.`
    );
  }

  console.log("\nApplying migration...");

  const result = await tuitions.updateMany(LEGACY_FILTER, {
    $set: {
      approvalStatus: "pending",
      status: "pending",
      isActive: true,
      updatedAt: new Date(),
    },
  });

  // Verify the update count.
  if (result.matchedCount !== EXPECTED_COUNT) {
    throw new Error(
      `Safety check failed: expected ${EXPECTED_COUNT} matched records, but got ${result.matchedCount}.`
    );
  }

  if (result.modifiedCount !== EXPECTED_COUNT) {
    throw new Error(
      `Verification failed: expected ${EXPECTED_COUNT} modified records, but got ${result.modifiedCount}.`
    );
  }

  // Verify that all migrated records are now pending.
  const remaining = await tuitions.countDocuments({
    ...LEGACY_FILTER,
  });

  const pendingCount = await tuitions.countDocuments({
    approvalStatus: "pending",
    isActive: true,
  });

  console.log("\n======================================");
  console.log(" MIGRATION COMPLETED");
  console.log("======================================");
  console.log(`Matched records: ${result.matchedCount}`);
  console.log(`Modified records: ${result.modifiedCount}`);
  console.log(`Remaining legacy records: ${remaining}`);
  console.log(`Total pending and active records: ${pendingCount}`);
  console.log("\nAll 8 targeted records are now marked as pending.");
}

migrateLegacyTuitions()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("\nMIGRATION FAILED:");
    console.error(error);
    process.exit(1);
  });
