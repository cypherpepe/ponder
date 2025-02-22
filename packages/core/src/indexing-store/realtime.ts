import type { Common } from "@/common/common.js";
import {
  InvalidStoreMethodError,
  RecordNotFoundError,
  UndefinedTableError,
} from "@/common/errors.js";
import type { Database } from "@/database/index.js";
import {
  type Schema,
  getPrimaryKeyColumns,
  getTableNames,
  onchain,
} from "@/drizzle/index.js";
import { prettyPrint } from "@/utils/print.js";
import {
  type QueryWithTypings,
  type SQL,
  type SQLWrapper,
  type Table,
  and,
  eq,
} from "drizzle-orm";
import { type PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pg-proxy";
import { createQueue } from "../../../common/src/queue.js";
import { type IndexingStore, parseSqlError } from "./index.js";

/** Throw an error if `table` is not an `onchainTable`. */
const checkOnchainTable = (
  table: Table,
  method: "find" | "insert" | "update" | "delete",
) => {
  if (table === undefined)
    throw new UndefinedTableError(
      `Table object passed to db.${method}() is undefined`,
    );

  if (onchain in table) return;

  throw new InvalidStoreMethodError(
    method === "find"
      ? `db.find() can only be used with onchain tables, and '${getTableConfig(table).name}' is an offchain table.`
      : `Indexing functions can only write to onchain tables, and '${getTableConfig(table).name}' is an offchain table.`,
  );
};

export const createRealtimeIndexingStore = ({
  database,
  schema,
}: {
  common: Common;
  database: Database;
  schema: Schema;
}): IndexingStore<"realtime"> => {
  // Operation queue to make sure all queries are run in order, circumventing race conditions
  const queue = createQueue<unknown, () => Promise<unknown>>({
    browser: false,
    initialStart: true,
    concurrency: 1,
    worker: (fn) => {
      return fn();
    },
  });

  const tableNameCache: Map<Table, string> = new Map();
  const primaryKeysCache: Map<Table, { sql: string; js: string }[]> = new Map();

  for (const tableName of getTableNames(schema, "")) {
    primaryKeysCache.set(
      schema[tableName.js] as Table,
      getPrimaryKeyColumns(schema[tableName.js] as PgTable),
    );

    tableNameCache.set(schema[tableName.js] as Table, tableName.user);
  }

  ////////
  // Helper functions
  ////////

  /** Returns an sql where condition for `table` with `key`. */
  const getWhereCondition = (table: Table, key: Object): SQL<unknown> => {
    primaryKeysCache.get(table)!;

    const conditions: SQLWrapper[] = [];

    for (const { js } of primaryKeysCache.get(table)!) {
      // @ts-ignore
      conditions.push(eq(table[js]!, key[js]));
    }

    return and(...conditions)!;
  };

  const find = (table: Table, key: object) => {
    return database.drizzle
      .select()
      .from(table)
      .where(getWhereCondition(table, key))
      .then((res) => (res.length === 0 ? null : res[0]!));
  };

  // @ts-ignore
  const indexingStore = {
    // @ts-ignore
    find: (table: Table, key) =>
      queue.add(() =>
        database.qb.user.wrap(
          { method: `${tableNameCache.get(table) ?? "unknown"}.find()` },
          async () => {
            checkOnchainTable(table, "find");

            return find(table, key);
          },
        ),
      ),

    // @ts-ignore
    insert(table: Table) {
      return {
        values: (values: any) => {
          // @ts-ignore
          const inner = {
            onConflictDoNothing: () =>
              queue.add(() =>
                database.qb.user.wrap(
                  {
                    method: `${tableNameCache.get(table) ?? "unknown"}.insert()`,
                  },
                  async () => {
                    checkOnchainTable(table, "insert");

                    try {
                      return await database.drizzle
                        .insert(table)
                        .values(values)
                        .onConflictDoNothing()
                        .returning();
                    } catch (e) {
                      parseSqlError(e);
                      throw e;
                    }
                  },
                ),
              ),
            onConflictDoUpdate: (valuesU: any) =>
              queue.add(() =>
                database.qb.user.wrap(
                  {
                    method: `${tableNameCache.get(table) ?? "unknown"}.insert()`,
                  },
                  async () => {
                    checkOnchainTable(table, "insert");

                    if (typeof valuesU === "object") {
                      try {
                        return await database.drizzle
                          .insert(table)
                          .values(values)
                          .onConflictDoUpdate({
                            target: primaryKeysCache
                              .get(table)!
                              // @ts-ignore
                              .map(({ js }) => table[js]),
                            set: valuesU,
                          })
                          .returning();
                      } catch (e) {
                        parseSqlError(e);
                        throw e;
                      }
                    }

                    if (Array.isArray(values)) {
                      const rows = [];
                      for (const value of values) {
                        const row = await find(table, value);

                        if (row === null) {
                          try {
                            rows.push(
                              await database.drizzle
                                .insert(table)
                                .values(value)
                                .returning(),
                            );
                          } catch (e) {
                            parseSqlError(e);
                            throw e;
                          }
                        } else {
                          try {
                            rows.push(
                              await database.drizzle
                                .update(table)
                                .set(valuesU(row))
                                .where(getWhereCondition(table, value))
                                .returning(),
                            );
                          } catch (e) {
                            parseSqlError(e);
                            throw e;
                          }
                        }
                      }
                      return rows;
                    } else {
                      const row = await find(table, values);

                      if (row === null) {
                        try {
                          return await database.drizzle
                            .insert(table)
                            .values(values)
                            .returning();
                        } catch (e) {
                          parseSqlError(e);
                          throw e;
                        }
                      } else {
                        try {
                          return await database.drizzle
                            .update(table)
                            .set(valuesU(row))
                            .where(getWhereCondition(table, values))
                            .returning();
                        } catch (e) {
                          parseSqlError(e);
                          throw e;
                        }
                      }
                    }
                  },
                ),
              ),
            // biome-ignore lint/suspicious/noThenProperty: <explanation>
            then: (onFulfilled, onRejected) =>
              queue
                .add(() =>
                  database.qb.user.wrap(
                    {
                      method: `${tableNameCache.get(table) ?? "unknown"}.insert()`,
                    },
                    async () => {
                      checkOnchainTable(table, "insert");

                      try {
                        return await database.drizzle
                          .insert(table)
                          .values(values)
                          .returning();
                      } catch (e) {
                        parseSqlError(e);
                        throw e;
                      }
                    },
                  ),
                )
                .then(onFulfilled, onRejected),
            catch: (onRejected) => inner.then(undefined, onRejected),
            finally: (onFinally) =>
              inner.then(
                (value: any) => {
                  onFinally?.();
                  return value;
                },
                (reason: any) => {
                  onFinally?.();
                  throw reason;
                },
              ),
            // @ts-ignore
          } satisfies ReturnType<
            ReturnType<IndexingStore<"realtime">["insert"]>["values"]
          >;

          return inner;
        },
      };
    },
    // @ts-ignore
    update(table: Table, key) {
      return {
        set: (values: any) =>
          queue.add(() =>
            database.qb.user.wrap(
              { method: `${tableNameCache.get(table) ?? "unknown"}.update()` },
              async () => {
                checkOnchainTable(table, "update");

                if (typeof values === "function") {
                  const row = await find(table, key);

                  if (row === null) {
                    const error = new RecordNotFoundError(
                      `No existing record found in table '${tableNameCache.get(table)}'`,
                    );
                    error.meta.push(
                      `db.update arguments:\n${prettyPrint(values)}`,
                    );
                    throw error;
                  }

                  try {
                    return await database.drizzle
                      .update(table)
                      .set(values(row))
                      .where(getWhereCondition(table, key))
                      .returning();
                  } catch (e) {
                    parseSqlError(e);
                    throw e;
                  }
                } else {
                  try {
                    return await database.drizzle
                      .update(table)
                      .set(values)
                      .where(getWhereCondition(table, key))
                      .returning();
                  } catch (e) {
                    parseSqlError(e);
                    throw e;
                  }
                }
              },
            ),
          ),
      };
    },
    // @ts-ignore
    delete: (table: Table, key) =>
      queue.add(() =>
        database.qb.user.wrap(
          { method: `${tableNameCache.get(table) ?? "unknown"}.delete()` },
          async () => {
            checkOnchainTable(table, "delete");

            const deleted = await database.drizzle
              .delete(table)
              .where(getWhereCondition(table, key))
              .returning();

            return deleted.length > 0;
          },
        ),
      ),
    // @ts-ignore
    sql: drizzle(
      (_sql, params, method, typings) =>
        // @ts-ignore
        queue.add(async () => {
          const query: QueryWithTypings = { sql: _sql, params, typings };

          const res = await database.qb.user.wrap(
            { method: "sql" },
            async () => {
              try {
                return await database.drizzle._.session
                  .prepareQuery(query, undefined, undefined, method === "all")
                  .execute();
              } catch (e) {
                parseSqlError(e);
                throw e;
              }
            },
          );

          // @ts-ignore
          return { rows: res.rows.map((row) => Object.values(row)) };
        }),
      { schema, casing: "snake_case" },
    ),
  } satisfies IndexingStore<"realtime">;

  // @ts-ignore
  return indexingStore;
};
