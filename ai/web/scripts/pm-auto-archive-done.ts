import { autoArchiveDoneTasks } from "@/lib/archive/auto";

async function main() {
  const result = await autoArchiveDoneTasks();
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
