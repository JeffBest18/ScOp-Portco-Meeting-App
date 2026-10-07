import { NextResponse } from 'next/server';
import { deleteCompanyFromSheet } from '@/lib/sheets';

export async function POST(request) {
  try {
    const { name } = await request.json();

    if (!name) {
      return NextResponse.json({ error: 'Company name is required' }, { status: 400 });
    }

    const result = await deleteCompanyFromSheet({ name });
    return NextResponse.json(result);
  } catch (error) {
    console.error('Delete company error:', error);
    return NextResponse.json(
      { error: 'Failed to delete company', message: error.message },
      { status: 500 }
    );
  }
}
