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

const ARR_HEADER = 'Current ARR';
const ARR_COL_INDEX = 3; // Column D

async function ensureArrColumn(sheets, sheetName) {
  // Check row 5 column D; if it's not the ARR header, insert a new column D.
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${sheetName}'!D5`,
  });
  const existing = ((res.data.values?.[0]?.[0]) || '').trim().toLowerCase();
  if (existing === ARR_HEADER.toLowerCase()) return false;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheetMeta = meta.data.sheets.find((s) => s.properties.title === sheetName);
  const numericSheetId = sheetMeta?.properties?.sheetId || 0;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{
        insertDimension: {
          range: {
            sheetId: numericSheetId,
            dimension: 'COLUMNS',
            startIndex: ARR_COL_INDEX,
            endIndex: ARR_COL_INDEX + 1,
          },
          inheritFromBefore: false,
        },
      }],
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${sheetName}'!D5`,
    valueInputOption: 'RAW',
    requestBody: { values: [[ARR_HEADER]] },
  });

  return true;
}

export async function fetchSheetData() {
  const sheets = await getSheets();
  const sheetName = await getSheetName(sheets);

  await ensureArrColumn(sheets, sheetName);

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
  // Column D (index 3) is Current ARR; date columns start at index 4 (column E)
  const dates = [];
  const dateColMap = {}; // date string → column index

  for (let i = ARR_COL_INDEX + 1; i < headerRow.length; i++) {
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
    const arr = (row[ARR_COL_INDEX] || '').toString();

    companies.push({ name, analyst, partner, arr });

    for (const date of dates) {
      const col = dateColMap[date];
      notes[date][name] = row[col] || '';
    }
  }

  return { companies, dates, notes, generalNotes, actionItems };
}

export async function syncToSheet({ date, notes, generalNotes, actionItems, companies, writeCompanyInfo }) {
  const sheets = await getSheets();
  const sheetName = await getSheetName(sheets);

  await ensureArrColumn(sheets, sheetName);

  // First, fetch current headers to find or create the date column
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${sheetName}'!1:5`,
  });

  const headerRows = headerRes.data.values || [];
  const headerRow = headerRows[4] || [];

  let dateCol = -1;
  for (let i = ARR_COL_INDEX + 1; i < headerRow.length; i++) {
    if ((headerRow[i] || '').trim() === date) {
      dateCol = i;
      break;
    }
  }

  // If date column doesn't exist, create it (appended after the last header cell)
  if (dateCol === -1) {
    dateCol = headerRow.length > ARR_COL_INDEX + 1 ? headerRow.length : ARR_COL_INDEX + 1;
  }

  const colLetter = columnToLetter(dateCol);
  const arrColLetter = columnToLetter(ARR_COL_INDEX);

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

  // General notes (rows 1-3)
  const gnLines = (generalNotes || '').split('\n');
  data.push({
    range: `'${sheetName}'!${colLetter}1:${colLetter}3`,
    values: [
      [gnLines[0] || ''],
      [gnLines[1] || ''],
      [gnLines[2] || ''],
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

  // Company name / analyst / partner (columns A:C), edited in the app
  if (writeCompanyInfo && companies) {
    data.push({
      range: `'${sheetName}'!A6:C${companies.length + 5}`,
      values: companies.map((c) => [c.name || '', c.analyst || '', c.partner || '']),
    });
  }

  // Company notes (rows 6+) and Current ARR (column D)
  if (companies && notes) {
    for (let i = 0; i < companies.length; i++) {
      const company = companies[i];
      const noteText = notes[company.name] || '';
      const rowNum = i + 6; // row 6 is first company
      data.push({
        range: `'${sheetName}'!${colLetter}${rowNum}`,
        values: [[noteText]],
      });
      if (company.arr !== undefined) {
        data.push({
          range: `'${sheetName}'!${arrColLetter}${rowNum}`,
          values: [[company.arr ?? '']],
        });
      }
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

function columnToLetter(col) {
  let letter = '';
  let c = col;
  while (c >= 0) {
    letter = String.fromCharCode((c % 26) + 65) + letter;
    c = Math.floor(c / 26) - 1;
  }
  return letter;
}
