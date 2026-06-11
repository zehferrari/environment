import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

type DateColumn = {
  tableName: string;
  columnName: string;
};

type ColumnAudit = DateColumn & {
  totalRows: number;
  nonNullRows: number;
  integerRows: number;
  realRows: number;
  textRows: number;
  numericTextRows: number;
  parseableTextRows: number;
  invalidTextRows: number;
};

const apply = process.argv.includes("--apply");
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl?.startsWith("file:")) {
  throw new Error("DATABASE_URL must be a file: SQLite URL");
}

const dbPath = resolve(dbUrl.slice("file:".length));
const backupPath = `${dbPath}.backup-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z")}`;
const db = new PrismaClient();

function quoteIdent(identifier: string) {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function quoteSqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function normalizedMsExpression(columnSql: string) {
  return [
    "CASE",
    `WHEN CAST(${columnSql} AS TEXT) NOT GLOB '*[^0-9]*' THEN CAST(${columnSql} AS INTEGER)`,
    `ELSE CAST(unixepoch(${columnSql}) AS INTEGER) * 1000 + CAST(substr(strftime('%f', ${columnSql}), 4, 3) AS INTEGER)`,
    "END",
  ].join(" ");
}

async function auditColumn(column: DateColumn): Promise<ColumnAudit> {
  const tableSql = quoteIdent(column.tableName);
  const columnSql = quoteIdent(column.columnName);
  const rows = await db.$queryRawUnsafe<Array<{
    totalRows: bigint | number;
    nonNullRows: bigint | number;
    integerRows: bigint | number;
    realRows: bigint | number;
    textRows: bigint | number;
    numericTextRows: bigint | number;
    parseableTextRows: bigint | number;
    invalidTextRows: bigint | number;
  }>>(`
    SELECT
      COUNT(*) AS totalRows,
      SUM(CASE WHEN ${columnSql} IS NOT NULL THEN 1 ELSE 0 END) AS nonNullRows,
      SUM(CASE WHEN typeof(${columnSql}) = 'integer' THEN 1 ELSE 0 END) AS integerRows,
      SUM(CASE WHEN typeof(${columnSql}) = 'real' THEN 1 ELSE 0 END) AS realRows,
      SUM(CASE WHEN typeof(${columnSql}) = 'text' THEN 1 ELSE 0 END) AS textRows,
      SUM(CASE WHEN typeof(${columnSql}) = 'text' AND CAST(${columnSql} AS TEXT) NOT GLOB '*[^0-9]*' THEN 1 ELSE 0 END) AS numericTextRows,
      SUM(CASE WHEN typeof(${columnSql}) = 'text' AND (CAST(${columnSql} AS TEXT) NOT GLOB '*[^0-9]*' OR unixepoch(${columnSql}) IS NOT NULL) THEN 1 ELSE 0 END) AS parseableTextRows,
      SUM(CASE WHEN typeof(${columnSql}) = 'text' AND NOT (CAST(${columnSql} AS TEXT) NOT GLOB '*[^0-9]*' OR unixepoch(${columnSql}) IS NOT NULL) THEN 1 ELSE 0 END) AS invalidTextRows
    FROM ${tableSql}
  `);
  const row = rows[0];
  const toNumber = (value: bigint | number | null | undefined) => Number(value ?? 0);
  return {
    ...column,
    totalRows: toNumber(row.totalRows),
    nonNullRows: toNumber(row.nonNullRows),
    integerRows: toNumber(row.integerRows),
    realRows: toNumber(row.realRows),
    textRows: toNumber(row.textRows),
    numericTextRows: toNumber(row.numericTextRows),
    parseableTextRows: toNumber(row.parseableTextRows),
    invalidTextRows: toNumber(row.invalidTextRows),
  };
}

async function main() {
  const columns = await db.$queryRawUnsafe<DateColumn[]>(`
    SELECT m.name AS tableName, p.name AS columnName
    FROM sqlite_master m
    JOIN pragma_table_info(m.name) p
    WHERE m.type = 'table'
      AND upper(p.type) LIKE '%DATE%'
    ORDER BY m.name, p.cid
  `);

  const audits: ColumnAudit[] = [];
  for (const column of columns) {
    audits.push(await auditColumn(column));
  }

  const changed = audits.filter((audit) => audit.textRows > 0 || audit.invalidTextRows > 0);
  console.table(changed.map((audit) => ({
    table: audit.tableName,
    column: audit.columnName,
    nonNull: audit.nonNullRows,
    integer: audit.integerRows,
    real: audit.realRows,
    text: audit.textRows,
    numericText: audit.numericTextRows,
    parseableText: audit.parseableTextRows,
    invalidText: audit.invalidTextRows,
  })));

  const updateTargets = audits.filter((audit) => audit.parseableTextRows > 0);
  const invalidTargets = audits.filter((audit) => audit.invalidTextRows > 0);
  const totalUpdates = updateTargets.reduce((sum, audit) => sum + audit.parseableTextRows, 0);
  const totalInvalid = invalidTargets.reduce((sum, audit) => sum + audit.invalidTextRows, 0);

  console.log(`${apply ? "apply" : "dry-run"}: ${totalUpdates} parseable text date value(s) would be normalized in ${updateTargets.length} column(s).`);
  if (totalInvalid > 0) {
    console.log(`warning: ${totalInvalid} invalid text date value(s) would be left unchanged.`);
  }

  if (!apply || totalUpdates === 0) return;

  mkdirSync(dirname(backupPath), { recursive: true });
  await db.$queryRawUnsafe(`VACUUM INTO ${quoteSqlString(backupPath)}`);
  console.log(`backup: ${backupPath}`);

  await db.$transaction(async (tx) => {
    for (const target of updateTargets) {
      const tableSql = quoteIdent(target.tableName);
      const columnSql = quoteIdent(target.columnName);
      const normalized = normalizedMsExpression(columnSql);
      const updated = await tx.$executeRawUnsafe(`
        UPDATE ${tableSql}
        SET ${columnSql} = ${normalized}
        WHERE typeof(${columnSql}) = 'text'
          AND (CAST(${columnSql} AS TEXT) NOT GLOB '*[^0-9]*' OR unixepoch(${columnSql}) IS NOT NULL)
      `);
      console.log(`updated ${updated}: ${target.tableName}.${target.columnName}`);
    }
  }, { maxWait: 5000, timeout: 30000 });
}

main()
  .finally(async () => {
    await db.$disconnect();
  });
