// Google Sheets API integration
// Uses service account credentials from env vars

import { google } from 'googleapis';

async function getSheets() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY;

  if (!email || !key) {
    throw new Error('Missing Google service account credentials in environment variables');
  }

  // Handle various formats Vercel might store the key in
  key = key.replace(/\\n/g, '\n');
  if (key.startsWith('"') && key.endsWith('"')) {
    key = JSON.parse(key);
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: email,
      private_key: key,
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

async function getSheetName(sheets) {
  // Auto-detect the first sheet tab name
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: 'sheets.properties.title',
  });
  const firstSheet = meta.data.sheets?.[0];
  return firstSheet?.properties?.title || 'Sheet1';
}

// Per-company metric columns, edited in the app. They sit between Partner
// (C) and the first date column; any that are missing get inserted in place
// so existing date columns shift right untouched.
export const METRIC_COLUMNS = [
  { key: 'arr', header: 'Current ARR' },
  { key: 'growth', header: 'Growth' },
  { key: 'runway', header: 'Runway' },
  { key: 'raised', header: 'Amount Raised' },
  { key: 'scopInvestment', header: 'ScOp Investment' },
];
const FIRST_METRIC_COL = 3; // Column D
const FIRST_DATE_COL = FIRST_METRIC_COL + METRIC_COLUMNS.length; // Column I

async function ensureMetricColumns(sheets, sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${sheetName}'!5:5`,
  });
  const header = [...(res.data.values?.[0] || [])];
  const missing = [];
  METRIC_COLUMNS.forEach((m, i) => {
    const col = FIRST_METRIC_COL + i;
    if ((header[col] || '').trim().toLowerCase() !== m.header.toLowerCase()) {
      missing.push(col);
      header.splice(col, 0, m.header);
    }
  });
  if (!missing.length) return false;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheetMeta = meta.data.sheets.find((s) => s.properties.title === sheetName);
  const numericSheetId = sheetMeta?.properties?.sheetId || 0;

  // Insert in ascending order: each index already accounts for earlier inserts.
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: missing.map((col) => ({
        insertDimension: {
          range: { sheetId: numericSheetId, dimension: 'COLUMNS', startIndex: col, endIndex: col + 1 },
          inheritFromBefore: false,
        },
      })),
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${sheetName}'!${columnToLetter(FIRST_METRIC_COL)}5:${columnToLetter(FIRST_DATE_COL - 1)}5`,
    valueInputOption: 'RAW',
    requestBody: { values: [METRIC_COLUMNS.map((m) => m.header)] },
  });

  return true;
}

export async function fetchSheetData() {
  const sheets = await getSheets();
  const sheetName = await getSheetName(sheets);

  await ensureMetricColumns(sheets, sheetName);

  // Fetch a wide range to capture all date columns
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${sheetName}'!A1:ZZ200`,
  });

  const rows = res.data.values || [];
  if (rows.length < 5) {
    return { companies: [], dates: [], generalNotes: {}, actionItems: {} };
  }

  // Row 5 (index 4) is the header row
  const headerRow = rows[4] || [];
  // Columns D:H are metrics; date columns start at column I
  const dates = [];
  const dateColMap = {}; // date string → column index

  for (let i = FIRST_DATE_COL; i < headerRow.length; i++) {
    const val = (headerRow[i] || '').trim();
    if (val) {
      dates.push(val);
      dateColMap[val] = i;
    }
  }

  // Rows 1-3 (index 0-2): general notes per date
  const generalNotes = {};
  for (const date of dates) {
    const col = dateColMap[date];
    const parts = [];
    for (let r = 0; r < 3; r++) {
      const cell = rows[r]?.[col] || '';
      if (cell.trim()) parts.push(cell.trim());
    }
    generalNotes[date] = parts.join('\n');
  }

  // Row 4 (index 3): action items per date
  const actionItems = {};
  for (const date of dates) {
    const col = dateColMap[date];
    actionItems[date] = rows[3]?.[col] || '';
  }

  // Rows 6+ (index 5+): companies
  const companies = [];
  const notes = {};

  // Initialize notes per date
  for (const date of dates) {
    notes[date] = {};
  }

  for (let r = 5; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row[0]) continue;

    const name = (row[0] || '').trim();
    const analyst = (row[1] || '').trim();
    const partner = (row[2] || '').trim();
    const company = { name, analyst, partner };
    METRIC_COLUMNS.forEach((m, i) => {
      company[m.key] = (row[FIRST_METRIC_COL + i] ?? '').toString();
    });

    companies.push(company);

    for (const date of dates) {
      const col = dateColMap[date];
      notes[date][name] = row[col] || '';
    }
  }

  return { companies, dates, notes, generalNotes, actionItems };
}

export async function syncToSheet({ date, notes, generalNotes, actionItems, companies, writeCompanyInfo, renameFrom }) {
  const sheets = await getSheets();
  const sheetName = await getSheetName(sheets);

  await ensureMetricColumns(sheets, sheetName);

  // First, fetch current headers to find or create the date column
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${sheetName}'!1:5`,
  });

  const headerRows = headerRes.data.values || [];
  const headerRow = headerRows[4] || [];

  let dateCol = -1;
  for (let i = FIRST_DATE_COL; i < headerRow.length; i++) {
    if ((headerRow[i] || '').trim() === date) {
      dateCol = i;
      break;
    }
  }

  // Date renamed in the app: reuse the column still labelled with the old date
  // (the row 5 header write below relabels it).
  if (dateCol === -1 && renameFrom) {
    for (let i = FIRST_DATE_COL; i < headerRow.length; i++) {
      if ((headerRow[i] || '').trim() === renameFrom) {
        dateCol = i;
        break;
      }
    }
  }

  // If date column doesn't exist, create it (appended after the last header cell)
  if (dateCol === -1) {
    dateCol = Math.max(headerRow.length, FIRST_DATE_COL);
  }

  const colLetter = columnToLetter(dateCol);

  // The Sheets values API does NOT auto-expand the grid. If the (possibly new)
  // date column falls outside the sheet's current column count, writing to it
  // fails with "Range exceeds grid limits". Widen the grid first.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheetMeta = meta.data.sheets.find(
    (s) => s.properties.title === sheetName
  );
  const numericSheetId = sheetMeta?.properties?.sheetId || 0;
  const currentColCount = sheetMeta?.properties?.gridProperties?.columnCount || 0;

  if (dateCol + 1 > currentColCount) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{
          appendDimension: {
            sheetId: numericSheetId,
            dimension: 'COLUMNS',
            length: dateCol + 1 - currentColCount,
          },
        }],
      },
    });
  }

  // Build batch update data
  const data = [];

  // Header (row 5)
  data.push({
    range: `'${sheetName}'!${colLetter}5`,
    values: [[date]],
  });

  // General notes (rows 1-3). Undefined means unchanged — leave the cells alone.
  const gnLines = (generalNotes || '').split('\n');
  if (generalNotes !== undefined) data.push({
    range: `'${sheetName}'!${colLetter}1:${colLetter}3`,
    values: [
      [gnLines[0] || ''],
      [gnLines[1] || ''],
      [gnLines.slice(2).join('\n')], // keep any extra lines rather than dropping them
    ],
  });

  // Action items (row 4). Undefined means "leave as is" — used when saving
  // edits to a past week so its recorded action items aren't wiped.
  if (actionItems !== undefined) {
    data.push({
      range: `'${sheetName}'!${colLetter}4`,
      values: [[actionItems || '']],
    });
  }

  // Company name / analyst / partner + metrics (columns A:H), edited in the app
  if (writeCompanyInfo && companies) {
    data.push({
      range: `'${sheetName}'!A6:${columnToLetter(FIRST_DATE_COL - 1)}${companies.length + 5}`,
      values: companies.map((c) => [
        c.name || '', c.analyst || '', c.partner || '',
        ...METRIC_COLUMNS.map((m) => c[m.key] ?? ''),
      ]),
    });
  }

  // Company notes (rows 6+)
  if (companies && notes) {
    for (let i = 0; i < companies.length; i++) {
      const company = companies[i];
      // Only companies whose note was edited are sent; skip the rest.
      if (!Object.prototype.hasOwnProperty.call(notes, company.name)) continue;
      const noteText = notes[company.name] || '';
      const rowNum = i + 6; // row 6 is first company
      data.push({
        range: `'${sheetName}'!${colLetter}${rowNum}`,
        values: [[noteText]],
      });
    }
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data,
    },
  });

  // Apply formatting to the date header cell in row 5:
  // Bold, Arial, size 10, centered — matching existing date columns
  // (numericSheetId resolved above when checking grid width)
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId: numericSheetId,
              startRowIndex: 4,  // row 5 (0-indexed)
              endRowIndex: 5,
              startColumnIndex: dateCol,
              endColumnIndex: dateCol + 1,
            },
            cell: {
              userEnteredFormat: {
                textFormat: {
                  fontFamily: 'Arial',
                  fontSize: 10,
                  bold: true,
                },
                horizontalAlignment: 'CENTER',
              },
            },
            fields: 'userEnteredFormat(textFormat,horizontalAlignment)',
          },
        },
      ],
    },
  });

  return { success: true, updatedCells: data.length };
}

export async function addCompanyToSheet({ name, analyst, partner }) {
  const sheets = await getSheets();
  const sheetName = await getSheetName(sheets);

  // Insert a row at position 6 (index 5)
  // First, get the sheet's numeric ID
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheetMeta = meta.data.sheets.find(
    (s) => s.properties.title === sheetName
  );
  const sheetId = sheetMeta?.properties?.sheetId || 0;

  // Insert row
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        {
          insertDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: 5, // row 6 (0-indexed)
              endIndex: 6,
            },
            inheritFromBefore: false,
          },
        },
      ],
    },
  });

  // Write company info
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${sheetName}'!A6:C6`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[name, analyst, partner]],
    },
  });

  return { success: true };
}

export async function deleteCompanyFromSheet({ name }) {
  const sheets = await getSheets();
  const sheetName = await getSheetName(sheets);

  // Find the row by exact name rather than trusting a client-side index.
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${sheetName}'!A6:A200`,
  });
  const names = (res.data.values || []).map((r) => (r?.[0] || '').trim());
  const matches = names.reduce((acc, n, i) => (n === name ? [...acc, i] : acc), []);
  if (matches.length !== 1) {
    throw new Error(matches.length ? `"${name}" appears more than once in the sheet` : `"${name}" not found in the sheet`);
  }
  const rowIndex = 5 + matches[0]; // 0-indexed; row 6 is first company

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheetMeta = meta.data.sheets.find((s) => s.properties.title === sheetName);
  const sheetId = sheetMeta?.properties?.sheetId || 0;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 },
        },
      }],
    },
  });

  return { success: true };
}

function columnToLetter(col) {
  let letter = '';
  let c = col;
  while (c >= 0) {
    letter = String.fromCharCode((c % 26) + 65) + letter;
    c = Math.floor(c / 26) - 1;
  }
  return letter;
}
