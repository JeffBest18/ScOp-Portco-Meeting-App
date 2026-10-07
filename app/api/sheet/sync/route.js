import { NextResponse } from 'next/server';
import { syncToSheet } from '@/lib/sheets';

export async function POST(request) {
  try {
    const body = await request.json();
    const { date, notes, generalNotes, actionItems, companies, writeCompanyInfo, renameFrom } = body;

    if (!date) {
      return NextResponse.json({ error: 'Date is required' }, { status: 400 });
    }

    const result = await syncToSheet({ date, notes, generalNotes, actionItems, companies, writeCompanyInfo, renameFrom });
    return NextResponse.json(result);
  } catch (error) {
    console.error('Sheet sync error:', error);

    // Surface the real reason so the client console / toast is actionable.
    // Google API errors carry a numeric `code` (e.g. 403 PERMISSION_DENIED
    // when the service account only has Viewer access to the sheet) and
    // nested error details under response.data.
    const apiCode = error?.code ?? error?.response?.status ?? null;
    const apiMessage =
      error?.response?.data?.error?.message || error?.message || 'Unknown error';

    const rawKey = process.env.GOOGLE_PRIVATE_KEY || '';
    const envCheck = {
      hasEmail: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '(not set)',
      hasKey: !!rawKey,
      hasSheetId: !!process.env.GOOGLE_SHEET_ID,
      sheetId: process.env.GOOGLE_SHEET_ID || '(not set)',
      keyLength: rawKey.length,
    };

    return NextResponse.json(
      {
        error: 'Failed to sync to sheet',
        code: apiCode,
        message: apiMessage,
        hint:
          apiCode === 403
            ? `The service account (${envCheck.serviceAccountEmail}) can read the sheet but cannot write to it. Share the Google Sheet with that email as an Editor.`
            : undefined,
        envCheck,
      },
      { status: 500 }
    );
  }
}
