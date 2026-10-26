/**
 * In-memory fake of the Google Sheets Orders worksheet, so tests can assert
 * order appends and status updates without touching real Google Sheets.
 */

import type { GoogleSpreadsheetWorksheet } from "google-spreadsheet";
import { ORDERS_HEADER, type OrdersRow } from "../../src/sheets/schema.js";

/** Fake row with the minimal google-spreadsheet Row interface our code uses. */
class FakeRow {
  private data: Record<string, string | number>;
  _rowNumber: number;

  constructor(row: OrdersRow, rowNumber: number) {
    this.data = { ...row };
    this._rowNumber = rowNumber;
  }

  get(key: string): string | number | undefined {
    return this.data[key];
  }

  set(key: string, value: string | number): void {
    this.data[key] = value;
  }

  async save(): Promise<void> {
    // No-op - in-memory
  }
}

export class FakeOrdersSheet {
  private rows = new Map<string, FakeRow>(); // keyed by Order ID
  private nextRowNumber = 2; // row 1 is header
  appendCount = 0;
  updateCount = 0;

  async addRow(row: OrdersRow): Promise<void> {
    this.appendCount++;
    const orderId = String(row["Order ID"]);
    if (this.rows.has(orderId)) {
      throw new Error(`Order ${orderId} already exists (duplicate append)`);
    }
    this.rows.set(orderId, new FakeRow(row, this.nextRowNumber++));
  }

  async getRows(): Promise<FakeRow[]> {
    return Array.from(this.rows.values());
  }

  /** Total distinct rows (== number of orders that ever got a row). */
  get rowCount(): number {
    return this.rows.size;
  }

  /** Reset for test isolation. */
  reset(): void {
    this.rows.clear();
    this.nextRowNumber = 2;
    this.appendCount = 0;
    this.updateCount = 0;
  }
}

/** Create a minimal fake worksheet that implements just what the client needs. */
export function createFakeOrdersWorksheet(fake: FakeOrdersSheet): GoogleSpreadsheetWorksheet {
  return {
    headerValues: [...ORDERS_HEADER],
    rowCount: fake.rowCount,
    addRow: (row: Record<string, string | number>) => fake.addRow(row as OrdersRow),
    getRows: () => fake.getRows(),
    loadHeaderRow: async () => { /* no-op */ },
    setHeaderRow: async () => { /* no-op */ },
    title: "Orders",
    sheetId: 0,
    gridProperties: { rowCount: 1000, columnCount: ORDERS_HEADER.length },
    addRows: async () => { throw new Error("not implemented"); },
    deleteRow: async () => { throw new Error("not implemented"); },
    deleteRows: async () => { throw new Error("not implemented"); },
    clear: async () => { /* no-op */ },
    loadCells: async () => { /* no-op */ },
    saveUpdatedCells: async () => { /* no-op */ },
    getCell: () => null,
    getCellByA1: () => null,
    eachRow: async () => { /* no-op */ },
  } as unknown as GoogleSpreadsheetWorksheet;
}