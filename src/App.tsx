import {AnimatePresence, motion} from 'motion/react';
import {
  FileSpreadsheet,
  Printer,
  Trash2,
  Upload,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  X,
  Eye,
  Edit3,
  Plus,
  FileText,
} from 'lucide-react';
import {type ReactNode, useCallback, useMemo, useRef, useState} from 'react';
import * as XLSX from 'xlsx';
import {
  ClientType,
  type AmortisationRow,
  type ClientInfo,
  type LoanStatusResult,
  type ParsedRTF,
  type Transaction,
  type TransactionDirection,
  type TransactionType,
  type UploadedDoc,
  type ValidationResult,
} from './types';

/* ──────────────────────────────────────────────
   HELPERS
   ────────────────────────────────────────────── */

const formatMoney = (value: number) =>
  value.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});

const parseDate = (value: string) => new Date(`${value}T00:00:00`);

const toISODate = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const formatDisplayDate = (value: string) => {
  if (!value) return '';
  const [y, m, d] = value.split('-');
  return `${d}/${m}/${y}`;
};

const todayStr = () => toISODate(new Date());

const round2 = (value: number) => Math.round(value * 100) / 100;

/* ──────────────────────────────────────────────
   RTF → PLAIN TEXT
   ────────────────────────────────────────────── */

function rtfToPlainText(rtf: string): string {
  let text = rtf;
  text = text.replace(/^\{?\\rtf1\b[^\{]*/, '');
  text = text.replace(/\{ *\\(fonttbl|colortbl|stylesheet|listtable|listoverride|themedata|generator|viewkind1|lang)[^}]*\}/gi, '');
  text = text.replace(/\{\\pict[^}]*\}/gi, '');
  text = text.replace(/\{\\field[^}]*\}/gi, '');
  text = text.replace(/\{\\\\xe[^}]*\}/gi, '');
  text = text.replace(/\\par[\d]*/gi, '\n');
  text = text.replace(/\\line[\d]*/gi, '\n');
  text = text.replace(/\\row[\d]*/gi, '\n');
  text = text.replace(/\\cell[\d]*/gi, '\t');
  text = text.replace(/\\tab[\d]*/gi, ' ');
  text = text.replace(/\\~/g, ' ');
  text = text.replace(/\\_/g, '-');
  text = text.replace(/\\[a-z]+[\d]*/gi, '');
  text = text.replace(/\\\{/g, '{');
  text = text.replace(/\\\}/g, '}');
  text = text.replace(/\\\\/g, '\\');
  let depth = 0;
  const result: string[] = [];
  for (const ch of text) {
    if (ch === '{') { depth++; continue; }
    if (ch === '}') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) result.push(ch);
  }
  return result.join('').replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
}

/* ──────────────────────────────────────────────
   PARSE PLAIN TEXT INTO STRUCTURED DATA
   ────────────────────────────────────────────── */

function parseStatementText(text: string): ParsedRTF | null {
  try {
    const blocks = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const joined: string[] = [];
    for (const line of blocks) {
      const prev = joined[joined.length - 1];
      if (prev && !line.includes(':') && !/\d{2}\/\d{2}\/\d{4}/.test(line)) {
        joined[joined.length - 1] = prev + ' ' + line;
      } else {
        joined.push(line);
      }
    }

    const extractField = (labels: string[]): string => {
      for (const label of labels) {
        const found = joined.find((l) => l.toLowerCase().includes(label.toLowerCase()));
        if (!found) continue;
        const idx = found.toLowerCase().indexOf(label.toLowerCase()) + label.length;
        let val = found.slice(idx).replace(/^[\s:–—|]+/, '').trim();
        if (!val) {
          const pos = joined.indexOf(found);
          if (pos + 1 < joined.length && !joined[pos + 1].includes(':')) {
            val = joined[pos + 1].trim();
          }
        }
        if (val) return val;
      }
      return '';
    };

    const extractNumber = (labels: string[]): number => {
      for (const label of labels) {
        const found = joined.find((l) => l.toLowerCase().includes(label.toLowerCase()));
        if (!found) continue;
        const nums = found.match(/[\d,]+\.\d{2}/g);
        if (nums) return parseFloat(nums[nums.length - 1].replace(/,/g, ''));
        const snums = found.match(/[\d,]+(?:\s*m²)?/gi);
        if (snums) return parseFloat(snums[snums.length - 1].replace(/,/g, ''));
      }
      return 0;
    };

    const standNo = extractField(['Stand Number', 'Stand No', 'Stand#', 'Stand #', 'Stand']);
    const sizeStr = extractField(['Stand Size', 'Size']);
    const clientName = extractField(['Client Name', 'Client', 'Customer Name', 'Customer']);
    const contact = extractField(['Client Contact', 'Contact', 'Phone', 'Mobile', 'Cell', 'Tel']);
    const standSize = parseInt(sizeStr.replace(/[^0-9]/g, ''), 10) || 400;
    const propertyValue = extractNumber(['Original Property Value', 'Property Value', 'Property value', 'Total Property']);
    const totalPaid = extractNumber(['Total Amount Paid', 'Total Paid', 'Amount Paid']);
    const monthlyInstalment = extractNumber(['Monthly Instalment', 'Instalment', 'Minimum']);

    let loanStatus = '';
    const statusLine = joined.find((l) => l.toLowerCase().includes('loan status') || l.toLowerCase().includes('status:'));
    if (statusLine) {
      const parts = statusLine.split(':');
      loanStatus = parts.length > 1 ? parts.slice(1).join(':').trim() : '';
      if (!loanStatus) {
        const pos = joined.indexOf(statusLine);
        if (pos + 1 < joined.length) loanStatus = joined[pos + 1].trim();
      }
    }

    /* Transaction rows */
    const transactions: Transaction[] = [];
    const seen = new Set<string>();
    const descMap: Record<string, {type: TransactionType; direction: TransactionDirection}> = {
      'Instalment Payment': {type: 'Instalment Payment', direction: 'credit'},
      'Interest accrued': {type: 'Interest Accrued', direction: 'debit'},
      'Interest Accrued': {type: 'Interest Accrued', direction: 'debit'},
      INTEREST: {type: 'Interest Accrued', direction: 'debit'},
      'Booking Fee': {type: 'Booking Fee', direction: 'credit'},
      BOOKING_FEE: {type: 'Booking Fee', direction: 'credit'},
      BOOKING: {type: 'Booking Fee', direction: 'credit'},
      'Property Value': {type: 'Property Value', direction: 'none'},
      'Property value': {type: 'Property Value', direction: 'none'},
      'Manual Adjustment': {type: 'Manual Adjustment', direction: 'debit'},
    };

    const txnBlocks = joined.filter((l) => /\d{2}\/\d{2}\/\d{4}/.test(l));
    for (const block of txnBlocks) {
      const dateMatch = block.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (!dateMatch) continue;
      const [, dd, mm, yyyy] = dateMatch;
      const date = `${yyyy}-${mm}-${dd}`;
      const dateKey = `${date}-${block}`;
      if (seen.has(dateKey)) continue;
      seen.add(dateKey);

      const amounts = [...block.matchAll(/[\d,]+\.\d{2}/g)].map((m) => parseFloat(m[0].replace(/,/g, '')));
      if (amounts.length < 2) continue;

      let debit = 0;
      let credit = 0;
      if (amounts.length === 2) { credit = amounts[0]; debit = amounts[1]; }
      else if (amounts.length >= 3) { debit = amounts[amounts.length - 3]; credit = amounts[amounts.length - 2]; }

      const matchedKey = Object.keys(descMap).find((key) => block.toUpperCase().includes(key.toUpperCase()));
      const mapping = matchedKey ? descMap[matchedKey] : {type: 'Manual Adjustment' as TransactionType, direction: 'debit' as TransactionDirection};
      const balanceMatch = amounts[amounts.length - 1];

      transactions.push({
        id: `doc-${transactions.length}`,
        date,
        type: mapping.type,
        direction: mapping.direction,
        amount: mapping.direction === 'credit' ? credit : debit,
        runningBalance: balanceMatch || 0,
      });
    }

    return {
      client: {name: clientName || 'Unknown', standNo: standNo || 'Unknown', standSize, contact: contact || 'Unknown'},
      propertyValue,
      totalPaid,
      monthlyInstalment,
      loanStatus,
      transactions,
    };
  } catch {
    return null;
  }
}

/* ──────────────────────────────────────────────
   CALCULATIONS ENGINE
   ────────────────────────────────────────────── */

const calcMonthlyInstalment = (principal: number, annualRate: number, months: number) => {
  if (principal <= 0 || months <= 0) return null;
  const r = annualRate / 100 / 12;
  if (r === 0) return round2(principal / months);
  const gf = Math.pow(1 + r, months);
  return round2(principal * ((r * gf) / (gf - 1)));
};

const calcDailyInterest = (balance: number, days: number) => round2(balance * (0.08 / 365) * days);

const calcRunningBalances = (openingBalance: number, transactions: Transaction[]) => {
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  let balance = round2(openingBalance);
  return sorted.map((txn) => {
    if (txn.direction === 'credit') balance = round2(balance - txn.amount);
    else if (txn.direction === 'debit') balance = round2(balance + txn.amount);
    return {...txn, runningBalance: balance};
  });
};

const consolidateInterestByMonth = (transactions: Transaction[]): Transaction[] => {
  const byMonth = new Map<string, {total: number; lastDate: string}>();
  const nonInterest: Transaction[] = [];
  for (const t of transactions) {
    if (t.type === 'Interest Accrued' && t.direction === 'debit') {
      const m = t.date.slice(0, 7);
      const cur = byMonth.get(m);
      byMonth.set(m, {total: round2((cur?.total ?? 0) + t.amount), lastDate: cur && cur.lastDate > t.date ? cur.lastDate : t.date});
    } else {
      nonInterest.push(t);
    }
  }
  for (const [month, {total, lastDate}] of byMonth) {
    nonInterest.push({id: `ci:${month}`, date: lastDate, type: 'Interest Accrued', direction: 'debit', amount: total, runningBalance: 0});
  }
  return nonInterest.sort((a, b) => a.date.localeCompare(b.date));
};

const buildAmortSchedule = (
  openingBalance: number,
  monthlyInstalment: number,
  loanStartDate: string,
  loanTerm: number,
): AmortisationRow[] => {
  if (monthlyInstalment <= 0 || loanTerm <= 0) return [];
  const rate = 0.08 / 12;
  const start = parseDate(loanStartDate);
  const rows: AmortisationRow[] = [];
  let balance = openingBalance;
  for (let i = 1; i <= loanTerm; i++) {
    const interest = round2(balance * rate);
    const principal = round2(monthlyInstalment - interest);
    balance = round2(balance - principal);
    if (balance < 0) balance = 0;
    const nextDate = new Date(start.getFullYear(), start.getMonth() + i, start.getDate());
    rows.push({month: i, date: toISODate(nextDate), interest, principal, balance});
    if (balance <= 0) break;
  }
  return rows;
};

const determineLoanStatus = (
  openingBalance: number,
  actualBalance: number,
  totalPaid: number,
  monthlyInstalment: number,
  loanStartDate: string,
  statementDate: string,
  loanTerm: number,
  transactions: Transaction[],
  amortSchedule: AmortisationRow[],
): LoanStatusResult => {
  if (actualBalance <= 0) return {status: 'Paid Off', detail: `Fully settled as of ${formatDisplayDate(statementDate)}`};

  const start = parseDate(loanStartDate);
  const stmt = parseDate(statementDate);
  let todayMonth = 0;
  let cursor = new Date(start.getFullYear(), start.getMonth() + 1, start.getDate());
  while (cursor <= stmt) { todayMonth++; cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate()); }
  todayMonth = Math.max(0, Math.min(todayMonth, loanTerm));

  let expectedBalance: number;
  if (todayMonth === 0) expectedBalance = openingBalance;
  else if (todayMonth >= loanTerm) expectedBalance = 0;
  else expectedBalance = amortSchedule[todayMonth - 1]?.balance ?? openingBalance;

  const balanceDiff = round2(actualBalance - expectedBalance);
  const balanceDiffPct = openingBalance > 0 ? round2((balanceDiff / openingBalance) * 100) : 0;
  const expectedPaid = round2(openingBalance - expectedBalance);
  const coverageRatio = expectedPaid > 0 ? round2(totalPaid / expectedPaid) : 1;

  const instalmentTxns = transactions.filter((t) => t.type === 'Instalment Payment' && t.date <= statementDate);
  const lastPayment = instalmentTxns[instalmentTxns.length - 1] ?? null;
  let daysSinceLast = 9999;
  let missedMonths = 0;
  if (lastPayment) {
    daysSinceLast = Math.round((stmt.getTime() - parseDate(lastPayment.date).getTime()) / 86400000);
    missedMonths = Math.max(0, Math.floor(daysSinceLast / 30.44) - 1);
  }

  const paymentShortfall = round2(expectedPaid - totalPaid);

  if (actualBalance <= 0) return {status: 'Paid Off', detail: `Fully settled as of ${formatDisplayDate(statementDate)}`};
  if (missedMonths >= 2 || paymentShortfall > monthlyInstalment * 2 || coverageRatio < 0.7)
    return {status: 'In Arrears', detail: `\$${formatMoney(Math.max(0, paymentShortfall))} shortfall · ${missedMonths} missed instalments`};
  if (missedMonths === 1 || (coverageRatio >= 0.7 && coverageRatio < 0.9) || balanceDiffPct > 5)
    return {status: 'Behind', detail: `Balance \$${formatMoney(Math.abs(balanceDiff))} above schedule · last payment ${daysSinceLast} days ago`};
  if (coverageRatio >= 0.9 && coverageRatio <= 1.1 && missedMonths <= 0 && Math.abs(balanceDiffPct) <= 5)
    return {status: 'On Track', detail: `Balance within \$${formatMoney(Math.abs(balanceDiff))} of schedule`};
  if (coverageRatio > 1.1 && balanceDiffPct < -5 && missedMonths <= 0) {
    const monthsAhead = monthlyInstalment > 0 ? Math.floor((balanceDiff * -1) / monthlyInstalment) : 0;
    return {status: 'Ahead', detail: `Balance \$${formatMoney(Math.abs(balanceDiff))} below schedule · ~${monthsAhead} months ahead`};
  }
  if (totalPaid === 0 && todayMonth <= 1) {
    const firstDue = new Date(start.getFullYear(), start.getMonth() + 1, start.getDate());
    return {status: 'New Account', detail: `Loan opened ${formatDisplayDate(loanStartDate)} · first instalment due ${formatDisplayDate(toISODate(firstDue))}`};
  }
  return {status: 'On Track', detail: `Balance within \$${formatMoney(Math.abs(balanceDiff))} of schedule`};
};

/* ──────────────────────────────────────────────
   DEFAULT SAMPLE DATA
   ────────────────────────────────────────────── */

const CHIPO_TXNS: Transaction[] = [
  {id: 'c1', date: '2024-09-02', type: 'Property Value', direction: 'none', amount: 0, runningBalance: 0},
  {id: 'c2', date: '2024-09-02', type: 'Booking Fee', direction: 'credit', amount: 50, runningBalance: 0},
  {id: 'c3', date: '2024-08-23', type: 'Instalment Payment', direction: 'credit', amount: 2000, runningBalance: 0},
  {id: 'c4', date: '2024-08-26', type: 'Instalment Payment', direction: 'credit', amount: 4500, runningBalance: 0},
  {id: 'c5', date: '2024-09-30', type: 'Interest Accrued', direction: 'debit', amount: 173.91, runningBalance: 0},
  {id: 'c6', date: '2024-10-04', type: 'Interest Accrued', direction: 'debit', amount: 24.84, runningBalance: 0},
  {id: 'c7', date: '2024-10-04', type: 'Instalment Payment', direction: 'credit', amount: 1000, runningBalance: 0},
  {id: 'c8', date: '2024-10-31', type: 'Interest Accrued', direction: 'debit', amount: 162.89, runningBalance: 0},
  {id: 'c9', date: '2024-11-19', type: 'Interest Accrued', direction: 'debit', amount: 114.63, runningBalance: 0},
  {id: 'c10', date: '2024-11-19', type: 'Instalment Payment', direction: 'credit', amount: 2000, runningBalance: 0},
  {id: 'c11', date: '2024-11-30', type: 'Interest Accrued', direction: 'debit', amount: 62.15, runningBalance: 0},
  {id: 'c12', date: '2024-12-31', type: 'Interest Accrued', direction: 'debit', amount: 175.16, runningBalance: 0},
  {id: 'c13', date: '2025-01-31', type: 'Interest Accrued', direction: 'debit', amount: 175.16, runningBalance: 0},
  {id: 'c14', date: '2025-02-28', type: 'Interest Accrued', direction: 'debit', amount: 158.21, runningBalance: 0},
  {id: 'c15', date: '2025-03-31', type: 'Interest Accrued', direction: 'debit', amount: 175.16, runningBalance: 0},
  {id: 'c16', date: '2025-04-04', type: 'Interest Accrued', direction: 'debit', amount: 22.60, runningBalance: 0},
  {id: 'c17', date: '2025-04-04', type: 'Instalment Payment', direction: 'credit', amount: 1883, runningBalance: 0},
  {id: 'c18', date: '2025-04-30', type: 'Interest Accrued', direction: 'debit', amount: 140.47, runningBalance: 0},
  {id: 'c19', date: '2025-05-31', type: 'Interest Accrued', direction: 'debit', amount: 167.48, runningBalance: 0},
  {id: 'c20', date: '2025-06-09', type: 'Interest Accrued', direction: 'debit', amount: 48.62, runningBalance: 0},
  {id: 'c21', date: '2025-06-09', type: 'Instalment Payment', direction: 'credit', amount: 560, runningBalance: 0},
  {id: 'c22', date: '2025-06-30', type: 'Interest Accrued', direction: 'debit', amount: 112.51, runningBalance: 0},
  {id: 'c23', date: '2025-07-11', type: 'Interest Accrued', direction: 'debit', amount: 58.93, runningBalance: 0},
  {id: 'c24', date: '2025-07-11', type: 'Instalment Payment', direction: 'credit', amount: 560, runningBalance: 0},
  {id: 'c25', date: '2025-07-31', type: 'Interest Accrued', direction: 'debit', amount: 105.42, runningBalance: 0},
  {id: 'c26', date: '2025-08-06', type: 'Interest Accrued', direction: 'debit', amount: 31.63, runningBalance: 0},
  {id: 'c27', date: '2025-08-06', type: 'Instalment Payment', direction: 'credit', amount: 1000, runningBalance: 0},
  {id: 'c28', date: '2025-08-31', type: 'Interest Accrued', direction: 'debit', amount: 126.98, runningBalance: 0},
  {id: 'c29', date: '2025-09-30', type: 'Interest Accrued', direction: 'debit', amount: 152.38, runningBalance: 0},
  {id: 'c30', date: '2025-10-15', type: 'Interest Accrued', direction: 'debit', amount: 76.19, runningBalance: 0},
  {id: 'c31', date: '2025-10-15', type: 'Instalment Payment', direction: 'credit', amount: 650, runningBalance: 0},
  {id: 'c32', date: '2025-10-31', type: 'Interest Accrued', direction: 'debit', amount: 80.22, runningBalance: 0},
  {id: 'c33', date: '2025-11-30', type: 'Interest Accrued', direction: 'debit', amount: 150.42, runningBalance: 0},
  {id: 'c34', date: '2025-12-31', type: 'Interest Accrued', direction: 'debit', amount: 155.43, runningBalance: 0},
  {id: 'c35', date: '2026-01-01', type: 'Manual Adjustment', direction: 'debit', amount: 88.25, runningBalance: 0},
  {id: 'c36', date: '2026-01-31', type: 'Interest Accrued', direction: 'debit', amount: 156.04, runningBalance: 0},
  {id: 'c37', date: '2026-02-28', type: 'Interest Accrued', direction: 'debit', amount: 140.94, runningBalance: 0},
  {id: 'c38', date: '2026-03-31', type: 'Interest Accrued', direction: 'debit', amount: 156.04, runningBalance: 0},
  {id: 'c39', date: '2026-04-16', type: 'Interest Accrued', direction: 'debit', amount: 80.54, runningBalance: 0},
  {id: 'c40', date: '2026-04-16', type: 'Instalment Payment', direction: 'credit', amount: 3890, runningBalance: 0},
  {id: 'c41', date: '2026-04-30', type: 'Interest Accrued', direction: 'debit', amount: 61.23, runningBalance: 0},
  {id: 'c42', date: '2026-05-13', type: 'Interest Accrued', direction: 'debit', amount: 56.85, runningBalance: 0},
];

const CHIPO_CLIENT: ClientInfo = {
  name: 'Chipo Chirau',
  standNo: '4139',
  standSize: 400,
  contact: '',
};

function makeDefaultDoc(): UploadedDoc {
  return {
    id: crypto.randomUUID(),
    client: {...CHIPO_CLIENT},
    clientType: ClientType.NON_STAFF,
    deposit: 0,
    loanTerm: 65,
    statementDate: '2026-05-13',
    transactions: CHIPO_TXNS.map((t) => ({...t})),
    propertyValue: 34500,
    totalPaid: 18093,
  };
}

const JACQUELINE_TXNS: Transaction[] = [
  {id: 'j1', date: '2025-01-18', type: 'Property Value', direction: 'none', amount: 0, runningBalance: 0},
  {id: 'j2', date: '2025-01-18', type: 'Booking Fee', direction: 'credit', amount: 0, runningBalance: 0},
  {id: 'j3', date: '2025-01-18', type: 'Instalment Payment', direction: 'credit', amount: 467, runningBalance: 0},
  {id: 'j4', date: '2025-01-31', type: 'Interest Accrued', direction: 'debit', amount: 85.03, runningBalance: 0},
  {id: 'j5', date: '2025-02-28', type: 'Interest Accrued', direction: 'debit', amount: 183.14, runningBalance: 0},
  {id: 'j6', date: '2025-02-28', type: 'Instalment Payment', direction: 'credit', amount: 467, runningBalance: 0},
  {id: 'j7', date: '2025-03-18', type: 'Interest Accrued', direction: 'debit', amount: 116.94, runningBalance: 0},
  {id: 'j8', date: '2025-03-18', type: 'Instalment Payment', direction: 'credit', amount: 467, runningBalance: 0},
  {id: 'j9', date: '2025-03-31', type: 'Interest Accrued', direction: 'debit', amount: 83.44, runningBalance: 0},
  {id: 'j10', date: '2025-04-30', type: 'Interest Accrued', direction: 'debit', amount: 192.56, runningBalance: 0},
  {id: 'j11', date: '2025-04-30', type: 'Instalment Payment', direction: 'credit', amount: 467, runningBalance: 0},
  {id: 'j12', date: '2025-05-06', type: 'Interest Accrued', direction: 'debit', amount: 38.26, runningBalance: 0},
  {id: 'j13', date: '2025-05-06', type: 'Instalment Payment', direction: 'credit', amount: 32, runningBalance: 0},
  {id: 'j14', date: '2025-05-31', type: 'Interest Accrued', direction: 'debit', amount: 159.41, runningBalance: 0},
  {id: 'j15', date: '2025-06-05', type: 'Interest Accrued', direction: 'debit', amount: 31.88, runningBalance: 0},
  {id: 'j16', date: '2025-06-05', type: 'Instalment Payment', direction: 'credit', amount: 467, runningBalance: 0},
  {id: 'j17', date: '2025-06-18', type: 'Interest Accrued', direction: 'debit', amount: 82.11, runningBalance: 0},
  {id: 'j18', date: '2025-06-18', type: 'Instalment Payment', direction: 'credit', amount: 467, runningBalance: 0},
  {id: 'j19', date: '2025-06-30', type: 'Interest Accrued', direction: 'debit', amount: 74.77, runningBalance: 0},
  {id: 'j20', date: '2025-07-18', type: 'Interest Accrued', direction: 'debit', amount: 112.16, runningBalance: 0},
  {id: 'j21', date: '2025-07-18', type: 'Instalment Payment', direction: 'credit', amount: 467, runningBalance: 0},
  {id: 'j22', date: '2025-07-31', type: 'Interest Accrued', direction: 'debit', amount: 80.19, runningBalance: 0},
  {id: 'j23', date: '2025-08-07', type: 'Interest Accrued', direction: 'debit', amount: 43.18, runningBalance: 0},
  {id: 'j24', date: '2025-08-07', type: 'Instalment Payment', direction: 'credit', amount: 160, runningBalance: 0},
  {id: 'j25', date: '2025-08-31', type: 'Interest Accrued', direction: 'debit', amount: 147.85, runningBalance: 0},
  {id: 'j26', date: '2025-09-09', type: 'Interest Accrued', direction: 'debit', amount: 55.44, runningBalance: 0},
  {id: 'j27', date: '2025-09-09', type: 'Instalment Payment', direction: 'credit', amount: 500, runningBalance: 0},
  {id: 'j28', date: '2025-09-18', type: 'Interest Accrued', direction: 'debit', amount: 54.85, runningBalance: 0},
  {id: 'j29', date: '2025-09-18', type: 'Instalment Payment', direction: 'credit', amount: 467, runningBalance: 0},
  {id: 'j30', date: '2025-09-30', type: 'Interest Accrued', direction: 'debit', amount: 72.04, runningBalance: 0},
  {id: 'j31', date: '2025-10-18', type: 'Interest Accrued', direction: 'debit', amount: 108.05, runningBalance: 0},
  {id: 'j32', date: '2025-10-18', type: 'Instalment Payment', direction: 'credit', amount: 467, runningBalance: 0},
  {id: 'j33', date: '2025-10-31', type: 'Interest Accrued', direction: 'debit', amount: 77.21, runningBalance: 0},
  {id: 'j34', date: '2025-11-30', type: 'Interest Accrued', direction: 'debit', amount: 178.18, runningBalance: 0},
  {id: 'j35', date: '2025-12-31', type: 'Interest Accrued', direction: 'debit', amount: 184.11, runningBalance: 0},
  {id: 'j36', date: '2026-01-01', type: 'Manual Adjustment', direction: 'debit', amount: 108.72, runningBalance: 0},
  {id: 'j37', date: '2026-01-09', type: 'Interest Accrued', direction: 'debit', amount: 53.67, runningBalance: 0},
  {id: 'j38', date: '2026-01-09', type: 'Instalment Payment', direction: 'credit', amount: 954, runningBalance: 0},
  {id: 'j39', date: '2026-01-31', type: 'Interest Accrued', direction: 'debit', amount: 128.94, runningBalance: 0},
  {id: 'j40', date: '2026-02-28', type: 'Interest Accrued', direction: 'debit', amount: 164.11, runningBalance: 0},
  {id: 'j41', date: '2026-03-04', type: 'Interest Accrued', direction: 'debit', amount: 23.44, runningBalance: 0},
  {id: 'j42', date: '2026-03-04', type: 'Instalment Payment', direction: 'credit', amount: 934, runningBalance: 0},
  {id: 'j43', date: '2026-03-31', type: 'Interest Accrued', direction: 'debit', amount: 154.54, runningBalance: 0},
  {id: 'j44', date: '2026-03-31', type: 'Instalment Payment', direction: 'credit', amount: 467, runningBalance: 0},
  {id: 'j45', date: '2026-04-30', type: 'Interest Accrued', direction: 'debit', amount: 169.63, runningBalance: 0},
  {id: 'j46', date: '2026-05-13', type: 'Interest Accrued', direction: 'debit', amount: 73.51, runningBalance: 0},
];

const JACQUELINE_CLIENT: ClientInfo = {
  name: 'Jacqueline Damiso',
  standNo: '4589',
  standSize: 400,
  contact: '',
};

function makeStaffDoc(): UploadedDoc {
  return {
    id: crypto.randomUUID(),
    client: {...JACQUELINE_CLIENT},
    clientType: ClientType.STAFF,
    deposit: 0,
    loanTerm: 65,
    statementDate: '2026-05-13',
    transactions: JACQUELINE_TXNS.map((t) => ({...t})),
    propertyValue: 29900,
    totalPaid: 7250,
  };
}

/* ──────────────────────────────────────────────
   STATUS BADGE STYLES
   ────────────────────────────────────────────── */

const STATUS_STYLES: Record<string, {bg: string; text: string; border: string}> = {
  'Paid Off': {bg: '#d1fae5', text: '#065f46', border: '#6ee7b7'},
  Ahead: {bg: '#dbeafe', text: '#1e40af', border: '#93c5fd'},
  'On Track': {bg: '#dcfce7', text: '#166534', border: '#86efac'},
  Behind: {bg: '#fef9c3', text: '#854d0e', border: '#fde047'},
  'In Arrears': {bg: '#fee2e2', text: '#991b1b', border: '#fca5a5'},
  'New Account': {bg: '#f1f5f9', text: '#475569', border: '#cbd5e1'},
};

/* ──────────────────────────────────────────────
   APP
   ────────────────────────────────────────────── */

export default function App() {
  const [docs, setDocs] = useState<UploadedDoc[]>(() => [makeDefaultDoc(), makeStaffDoc()]);
  const [activeDocId, setActiveDocId] = useState<string>(docs[0]?.id ?? '');
  const [view, setView] = useState<'input' | 'output'>('input');
  const [validationOpen, setValidationOpen] = useState(true);
  const [uploadStatus, setUploadStatus] = useState('');
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  /* Add transaction form */
  const [newTxnDate, setNewTxnDate] = useState(todayStr());
  const [newTxnType, setNewTxnType] = useState<TransactionType>('Instalment Payment');
  const [newTxnAmount, setNewTxnAmount] = useState(0);
  const [newTxnDir, setNewTxnDir] = useState<TransactionDirection>('credit');
  const [interestFrom, setInterestFrom] = useState('');
  const [interestTo, setInterestTo] = useState('');
  const [autoInterest, setAutoInterest] = useState(0);
  const [factoryResetOpen, setFactoryResetOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ── Active document helpers ── */

  const activeDoc = useMemo(() => docs.find((d) => d.id === activeDocId) ?? docs[0], [docs, activeDocId]);
  const activeIdx = useMemo(() => docs.findIndex((d) => d.id === activeDocId), [docs, activeDocId]);

  const updateActiveDoc = useCallback((patch: Partial<UploadedDoc>) => {
    setDocs((prev) => prev.map((d) => d.id === activeDocId ? {...d, ...patch} : d));
  }, [activeDocId]);

  /* ── Derived calculations for active doc ── */

  const pricePerSqm = useMemo(() => (activeDoc?.clientType === ClientType.STAFF ? 65 : 75), [activeDoc?.clientType]);
  const baseCost = useMemo(() => round2((activeDoc?.client.standSize ?? 400) * pricePerSqm), [activeDoc?.client.standSize, pricePerSqm]);
  const vatAmount = useMemo(() => round2(baseCost * 0.155), [baseCost]);
  const propertyValue = useMemo(() => round2(baseCost + vatAmount), [baseCost, vatAmount]);
  const openingBalance = useMemo(
    () => activeDoc ? (activeDoc.clientType === ClientType.STAFF ? propertyValue : round2(propertyValue - (activeDoc.deposit ?? 0))) : 0,
    [activeDoc, activeDoc?.clientType, activeDoc?.deposit, propertyValue],
  );

  const consolidatedTxns = useMemo(
    () => activeDoc ? consolidateInterestByMonth(activeDoc.transactions) : [],
    [activeDoc?.transactions],
  );

  const runningTxns = useMemo(
    () => activeDoc ? calcRunningBalances(openingBalance, consolidatedTxns) : [],
    [activeDoc, consolidatedTxns, openingBalance],
  );

  const lastBalance = useMemo(
    () => runningTxns.length > 0 ? runningTxns[runningTxns.length - 1].runningBalance : openingBalance,
    [runningTxns, openingBalance],
  );

  const recalcInterest = useCallback(() => {
    if (interestFrom && interestTo) {
      const days = Math.round((parseDate(interestTo).getTime() - parseDate(interestFrom).getTime()) / 86400000);
      if (days > 0) {
        const amount = calcDailyInterest(lastBalance, days);
        setAutoInterest(amount);
        setNewTxnAmount(amount);
      }
    }
  }, [interestFrom, interestTo, lastBalance]);

  const totalPaid = useMemo(
    () => runningTxns.filter((t) => t.type === 'Instalment Payment' && t.direction === 'credit').reduce((s, t) => s + t.amount, 0),
    [runningTxns],
  );

  const totalDebit = useMemo(
    () => runningTxns.filter((t) => t.direction === 'debit').reduce((s, t) => s + t.amount, 0),
    [runningTxns],
  );

  const monthlyInstalment = useMemo(
    () => (activeDoc ? calcMonthlyInstalment(lastBalance, 8, activeDoc.loanTerm ?? 65) : null),
    [activeDoc?.loanTerm, lastBalance],
  );

  const sortedTxns = useMemo(
    () => activeDoc ? [...activeDoc.transactions].sort((a, b) => a.date.localeCompare(b.date)) : [],
    [activeDoc?.transactions],
  );

  const amortSchedule = useMemo(() => {
    if (!activeDoc) return [];
    const startDate = sortedTxns.length > 0 ? sortedTxns[0].date : todayStr();
    const m = calcMonthlyInstalment(openingBalance, 8, activeDoc.loanTerm ?? 65);
    return buildAmortSchedule(openingBalance, m ?? 0, startDate, activeDoc.loanTerm ?? 65);
  }, [activeDoc, openingBalance, sortedTxns]);

  const loanStartDate = useMemo(() => sortedTxns.length > 0 ? sortedTxns[0].date : todayStr(), [sortedTxns]);

  const loanStatusResult = useMemo((): LoanStatusResult => {
    if (!activeDoc) return {status: 'New Account', detail: ''};
    return determineLoanStatus(
      openingBalance, lastBalance, totalPaid, monthlyInstalment ?? 0,
      loanStartDate, activeDoc.statementDate, activeDoc.loanTerm ?? 65,
      activeDoc.transactions, amortSchedule,
    );
  }, [activeDoc, openingBalance, lastBalance, totalPaid, monthlyInstalment, loanStartDate, amortSchedule]);

  const activePaymentCount = useMemo(
    () => activeDoc ? activeDoc.transactions.filter((t) => t.type === 'Instalment Payment').length : 0,
    [activeDoc?.transactions],
  );

  /* ── Transaction actions ── */

  const addTransaction = useCallback(() => {
    if (!activeDoc || !newTxnDate) return;
    let dir = newTxnDir;
    if (newTxnType === 'Instalment Payment') dir = 'credit';
    else if (newTxnType === 'Interest Accrued') dir = 'debit';
    else if (newTxnType === 'Booking Fee') dir = 'credit';
    else if (newTxnType === 'Property Value') dir = 'none';

    const txn: Transaction = {
      id: crypto.randomUUID(), date: newTxnDate, type: newTxnType,
      direction: dir, amount: newTxnAmount, runningBalance: 0,
    };
    updateActiveDoc({transactions: [...activeDoc.transactions, txn]});
    if (newTxnType === 'Interest Accrued') { setInterestFrom(''); setInterestTo(''); setAutoInterest(0); }
    setNewTxnAmount(0); setNewTxnType('Instalment Payment'); setNewTxnDir('credit');
  }, [activeDoc, newTxnDate, newTxnType, newTxnAmount, newTxnDir, updateActiveDoc]);

  const removeTransaction = useCallback((txnId: string) => {
    if (!activeDoc) return;
    if (txnId.startsWith('ci:')) {
      const month = txnId.slice(3);
      updateActiveDoc({transactions: activeDoc.transactions.filter((t) => !(t.type === 'Interest Accrued' && t.date.startsWith(month)))});
    } else {
      updateActiveDoc({transactions: activeDoc.transactions.filter((t) => t.id !== txnId)});
    }
  }, [activeDoc, updateActiveDoc]);

  const clearInstalments = useCallback(() => {
    if (!activeDoc) return;
    updateActiveDoc({transactions: activeDoc.transactions.filter((t) => t.type !== 'Instalment Payment')});
  }, [activeDoc, updateActiveDoc]);

  const switchClientType = useCallback((type: ClientType) => {
    const target = docs.find((d) => d.clientType === type);
    if (target) setActiveDocId(target.id);
  }, [docs]);

  /* ── Factory reset ── */

  const factoryReset = useCallback(() => {
    const doc = makeDefaultDoc();
    setDocs([doc]);
    setActiveDocId(doc.id);
    setFactoryResetOpen(false);
    setUploadStatus('');
  }, []);

  const clearAllDocs = useCallback(() => {
    const doc = makeDefaultDoc();
    setDocs([doc]);
    setActiveDocId(doc.id);
    setUploadStatus('');
  }, []);

  const removeDoc = useCallback((id: string) => {
    setDocs((prev) => {
      const next = prev.filter((d) => d.id !== id);
      if (next.length === 0) {
        const doc = makeDefaultDoc();
        setActiveDocId(doc.id);
        return [doc];
      }
      if (id === activeDocId) setActiveDocId(next[0].id);
      return next;
    });
  }, [activeDocId]);

  const addNewDoc = useCallback(() => {
    const doc = makeDefaultDoc();
    doc.client = {name: 'New Client', standNo: '0000', standSize: 400, contact: ''};
    doc.transactions = [];
    doc.statementDate = todayStr();
    setDocs((prev) => [...prev, doc]);
    setActiveDocId(doc.id);
    setView('input');
  }, []);

  /* ── RTF Upload ── */

  const handleFile = useCallback(async (file: File) => {
    const ext = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
    if (ext !== '.rtf') {
      setUploadStatus('Please upload an .rtf file');
      return;
    }
    setUploading(true);
    setUploadStatus('Reading document...');
    try {
      const text = await file.text();
      const plain = rtfToPlainText(text);
      const parsed = parseStatementText(plain);
      if (!parsed || !parsed.client.name || parsed.client.name === 'Unknown') {
        setUploadStatus('Could not parse file — check format');
        setUploading(false);
        return;
      }
      const hasBooking = parsed.transactions.some((t) => t.type === 'Booking Fee');
      const detectedType = (!hasBooking && Math.abs(parsed.propertyValue - 29900) <= 50) ? ClientType.STAFF : ClientType.NON_STAFF;
      const lastDate = parsed.transactions.length > 0
        ? [...parsed.transactions].sort((a, b) => b.date.localeCompare(a.date))[0].date
        : todayStr();

      const doc: UploadedDoc = {
        id: crypto.randomUUID(),
        client: parsed.client,
        clientType: detectedType,
        deposit: 0,
        loanTerm: 65,
        statementDate: lastDate,
        transactions: parsed.transactions.map((t, i) => ({...t, id: `up-${Date.now()}-${i}`})),
        propertyValue: parsed.propertyValue,
        totalPaid: parsed.totalPaid,
      };
      setDocs((prev) => [...prev, doc]);
      setActiveDocId(doc.id);
      setUploadStatus(`Loaded — ${parsed.client.name}, Stand ${parsed.client.standNo} (${parsed.transactions.length} transactions)`);
      setUploading(false);
      setView('input');
    } catch {
      setUploadStatus('Could not parse file — check format');
      setUploading(false);
    }
  }, []);

  const onFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  /* ── Export ── */

  const exportToExcel = useCallback(() => {
    if (!activeDoc) return;
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', {month: 'numeric', day: 'numeric', year: 'numeric'}) + ', ' + now.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit', second: '2-digit'});

    const vatAdj = activeDoc.transactions.filter((t) => t.type === 'Manual Adjustment').reduce((s, t) => s + t.amount, 0);
    const revisedValue = round2(propertyValue + vatAdj);
    const startDate = loanStartDate;
    const start = parseDate(startDate);
    const stmt = parseDate(activeDoc.statementDate);
    let n = 0;
    let cursor = new Date(start.getFullYear(), start.getMonth() + 1, start.getDate());
    while (cursor <= stmt) { n++; cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate()); }

    const summaryData = [
      ['NORTHGATE ESTATES - ACCOUNT SIMULATION'],
      ['Exported on:', dateStr],
      [],
      ['INPUT PARAMETERS (EDITABLE)'],
      ['Client Name', activeDoc.client.name],
      ['Start Date', startDate],
      ['Statement Date', activeDoc.statementDate],
      ['Original Property Value', propertyValue],
      ['Annual Interest Rate %', 0.08],
      ['Loan Duration (Months)', activeDoc.loanTerm ?? 65],
      ['New VAT Rate %', 0.155],
      ['VAT Change Date', '2026-01-01'],
      [],
      ['LIVE CALCULATIONS'],
      ['Monthly Instalment (M)', monthlyInstalment ?? 0],
      ['Instalments Due (N)', n],
      ['Expected Total (E = N * M)', round2((monthlyInstalment ?? 0) * n)],
      ['Total Paid (P)', totalPaid],
      ['Catch-up Amount (E - P)', round2(((monthlyInstalment ?? 0) * n) - totalPaid)],
      ['VAT Adjustment Amount', vatAdj],
      ['Revised Property Value', revisedValue],
      ['Remaining Balance', lastBalance],
    ];

    const ledgerData = [
      ['Date', 'Details', 'Debit (+)', 'Credit (-)', 'Running Balance'],
      ...runningTxns.map((t) => [t.date, t.type, t.direction === 'debit' ? t.amount : 0, t.direction === 'credit' ? t.amount : 0, t.runningBalance]),
    ];

    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet(summaryData);
    ws1['!cols'] = [{wch: 30}, {wch: 18}];
    XLSX.utils.book_append_sheet(wb, ws1, 'Summary');

    const ws2 = XLSX.utils.aoa_to_sheet(ledgerData);
    ws2['!cols'] = [{wch: 14}, {wch: 24}, {wch: 14}, {wch: 14}, {wch: 18}];
    XLSX.utils.book_append_sheet(wb, ws2, 'Ledger');

    const fileName = `Northgate_Statement_${activeDoc.client.standNo}_${activeDoc.client.name.replace(/\s+/g, '_')}.xlsx`;
    XLSX.writeFile(wb, fileName);
  }, [activeDoc, runningTxns, propertyValue, loanStartDate, monthlyInstalment, totalPaid, lastBalance]);

  /* ── Render ── */

  return (
    <div className="min-h-screen bg-[#f7f7f5] text-[#1a1a18] selection:bg-navy/20">
      {/* ── TOP BAR ── */}
      <header className="sticky top-0 z-50 flex items-center gap-3 border-b-2 border-[#d40000] bg-[#1e295b] px-5 py-2.5 no-print">
        <HouseLogo />
        <div className="mr-4">
          <h1 className="text-sm font-black uppercase tracking-tight text-white">Northgate Estates</h1>
          <p className="text-[9px] font-bold uppercase tracking-[0.3em] text-white/70">Beyond a home!</p>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 rounded-lg bg-white/10 p-0.5">
          <button
            onClick={() => setView('input')}
            className={`flex items-center gap-1.5 rounded-md px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-all ${
              view === 'input' ? 'bg-white text-[#1e295b] shadow-sm' : 'text-white/80 hover:text-white'
            }`}
          >
            <Edit3 size={13} /> Data Input
          </button>
          <button
            onClick={() => setView('output')}
            className={`flex items-center gap-1.5 rounded-md px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-all ${
              view === 'output' ? 'bg-white text-[#1e295b] shadow-sm' : 'text-white/80 hover:text-white'
            }`}
          >
            <Eye size={13} /> Statement Output
          </button>
        </div>

        {/* Upload zone */}
        <div
          className={`ml-auto flex cursor-pointer items-center gap-2 rounded-lg border-2 border-dashed px-4 py-1.5 transition-colors ${
            dragOver ? 'border-red-400 bg-red-500/10' : 'border-white/20 bg-white/5 hover:border-white/40'
          }`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onFileDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload size={16} className="text-white/60" />
          <span className="text-[10px] font-medium text-white/60">
            {uploading ? 'Reading...' : uploadStatus || 'Drop .rtf or click'}
          </span>
          <input ref={fileInputRef} type="file" accept=".rtf" className="hidden" onChange={onFileSelect} />
          {uploading && <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-transparent" />}
          {uploadStatus && !uploading && !uploadStatus.includes('Could not') && <CheckCircle2 size={14} className="text-green-300" />}
          {uploadStatus && uploadStatus.includes('Could not') && <XCircle size={14} className="text-red-300" />}
        </div>
      </header>

      {/* ── INPUT VIEW ── */}
      {view === 'input' && (
        <div className="grid min-h-[calc(100vh-56px)] grid-cols-[320px_1fr] print:hidden">
          {/* Sidebar */}
          <aside className="sticky top-[56px] max-h-[calc(100vh-56px)] overflow-y-auto border-r border-gray-200 bg-white p-4 shadow-sm">
            {/* Document list */}
            <Section title="Documents">
              <div className="space-y-1.5">
                {docs.map((doc) => (
                  <div
                    key={doc.id}
                    className={`group flex items-center gap-2 rounded-md px-2.5 py-2 text-[11px] cursor-pointer transition-colors ${
                      doc.id === activeDocId ? 'bg-[#1e295b] text-white' : 'bg-gray-50 text-gray-700 hover:bg-gray-100'
                    }`}
                    onClick={() => setActiveDocId(doc.id)}
                  >
                    <FileText size={13} className="shrink-0 opacity-60" />
                    <span className="flex-1 truncate font-medium">{doc.client.name}</span>
                    <span className="text-[9px] opacity-60">#{doc.client.standNo}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeDoc(doc.id); }}
                      className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-white/20 group-hover:opacity-100"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
                <button
                  onClick={addNewDoc}
                  className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-gray-300 py-2 text-[10px] font-bold uppercase tracking-wider text-gray-500 transition-colors hover:border-gray-400 hover:text-gray-700"
                >
                  <Plus size={12} /> New Blank
                </button>
              </div>
            </Section>

            {activeDoc && (
              <>
                {/* Client Type Toggle */}
                <div className="mb-5">
                  <div className="flex rounded-lg bg-gray-100 p-0.5">
                    {([ClientType.NON_STAFF, ClientType.STAFF] as const).map((type) => (
                      <button
                        key={type}
                        onClick={() => switchClientType(type)}
                        className={`flex-1 rounded-md px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-all ${
                          activeDoc.clientType === type
                            ? 'bg-[#1e295b] text-white shadow-sm'
                            : 'text-gray-500 hover:text-[#1e295b]'
                        }`}
                      >
                        {type} {type === ClientType.STAFF ? '$65' : '$75'}
                      </button>
                    ))}
                  </div>
                  {uploadStatus && uploadStatus.includes('Loaded') && (
                    <p className="mt-1.5 text-[8px] text-gray-400 italic">{uploadStatus}</p>
                  )}
                </div>

                {/* Client Details */}
                <Section title="Client Details">
                  <Field label="Client Name">
                    <input value={activeDoc.client.name} onChange={(e) => updateActiveDoc({client: {...activeDoc.client, name: e.target.value}})} />
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Stand No.">
                      <input value={activeDoc.client.standNo} onChange={(e) => updateActiveDoc({client: {...activeDoc.client, standNo: e.target.value}})} />
                    </Field>
                    <Field label="Size (m²)">
                      <input type="number" value={activeDoc.client.standSize} onChange={(e) => updateActiveDoc({client: {...activeDoc.client, standSize: Number(e.target.value)}})} />
                    </Field>
                  </div>
                  <Field label="Contact">
                    <input value={activeDoc.client.contact} onChange={(e) => updateActiveDoc({client: {...activeDoc.client, contact: e.target.value}})} />
                  </Field>
                  <Field label="Statement Date">
                    <input type="date" value={activeDoc.statementDate} onChange={(e) => updateActiveDoc({statementDate: e.target.value})} />
                  </Field>
                </Section>

                {/* Property Pricing */}
                <Section title="Property Pricing">
                  <div className="space-y-1.5 text-[11px]">
                    <div className="flex justify-between"><span className="text-gray-400">Price/sqm</span><span className="font-bold text-[#1e295b]">${pricePerSqm}.00</span></div>
                    <div className="flex justify-between"><span className="text-gray-400">VAT</span><span className="font-bold text-[#1e295b]">15.5%</span></div>
                    <div className="flex justify-between"><span className="text-gray-400">Base Cost</span><span className="font-bold text-[#1e295b]">${formatMoney(baseCost)}</span></div>
                    <div className="flex justify-between"><span className="text-gray-400">VAT Amount</span><span className="font-bold text-[#d40000]">${formatMoney(vatAmount)}</span></div>
                    <div className="flex justify-between border-t border-gray-200 pt-1.5"><span className="font-bold text-gray-700">Property Value</span><span className="font-bold text-[#d40000]">${formatMoney(propertyValue)}</span></div>
                    {activeDoc.clientType === ClientType.NON_STAFF && (
                      <Field label="Deposit">
                        <input type="number" value={activeDoc.deposit} onChange={(e) => updateActiveDoc({deposit: Number(e.target.value)})} />
                      </Field>
                    )}
                    <div className="flex justify-between border-t border-gray-200 pt-1.5"><span className="font-bold text-gray-700">Opening Balance</span><span className="font-bold text-[#1e295b]">${formatMoney(openingBalance)}</span></div>
                  </div>
                </Section>

                {/* Loan Parameters */}
                <Section title="Loan Parameters">
                  <div className="space-y-2 text-[11px]">
                    <div className="flex justify-between"><span className="text-gray-400">Rate</span><span className="font-bold text-[#1e295b]">8%</span></div>
                    <Field label="Term (months)">
                      <input type="number" min={1} value={activeDoc.loanTerm} onChange={(e) => updateActiveDoc({loanTerm: Number(e.target.value)})} />
                    </Field>
                    <div className="flex justify-between rounded bg-gray-50 p-2"><span className="font-bold text-gray-700">Monthly Instalment</span><span className="font-bold text-[#d40000]">{monthlyInstalment ? `$${formatMoney(monthlyInstalment)}` : '—'}</span></div>
                  </div>
                </Section>

                {/* Add Transaction */}
                <Section title="Add Transaction">
                  <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 p-2.5">
                    <div className="space-y-2">
                      <Field label="Date">
                        <input type="date" value={newTxnDate} onChange={(e) => setNewTxnDate(e.target.value)} />
                      </Field>
                      <Field label="Type">
                        <select value={newTxnType} onChange={(e) => { const t = e.target.value as TransactionType; setNewTxnType(t); if (t !== 'Manual Adjustment') setNewTxnDir(t === 'Instalment Payment' || t === 'Booking Fee' ? 'credit' : t === 'Property Value' ? 'none' : 'debit'); }} className="w-full rounded border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-700">
                          <option>Instalment Payment</option>
                          <option>Interest Accrued</option>
                          {activeDoc.clientType === ClientType.NON_STAFF && <option>Booking Fee</option>}
                          <option>Manual Adjustment</option>
                        </select>
                      </Field>
                      {newTxnType === 'Interest Accrued' && (
                        <div className="space-y-2 rounded bg-white p-2">
                          <Field label="From"><input type="date" value={interestFrom} onChange={(e) => { setInterestFrom(e.target.value); setTimeout(recalcInterest, 0); }} /></Field>
                          <Field label="To"><input type="date" value={interestTo} onChange={(e) => { setInterestTo(e.target.value); setTimeout(recalcInterest, 0); }} /></Field>
                          <div className="text-center text-[10px] text-[#d40000]">Interest: ${formatMoney(autoInterest)}</div>
                        </div>
                      )}
                      {newTxnType === 'Manual Adjustment' && (
                        <Field label="Direction">
                          <select value={newTxnDir} onChange={(e) => setNewTxnDir(e.target.value as TransactionDirection)} className="w-full rounded border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-700">
                            <option value="credit">Credit (−)</option>
                            <option value="debit">Debit (+)</option>
                          </select>
                        </Field>
                      )}
                      {newTxnType !== 'Property Value' && (
                        <Field label="Amount">
                          <input type="number" step="0.01" value={newTxnAmount || ''} onChange={(e) => setNewTxnAmount(Number(e.target.value))} />
                        </Field>
                      )}
                      <button onClick={addTransaction} className="w-full rounded bg-[#1e295b] py-1.5 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-[#2a3a7b]">+ Add Transaction</button>
                    </div>
                  </div>
                </Section>

                {/* Active Payments */}
                <Section title="Active Payments">
                  <div className="mb-2 flex items-center justify-between">
                    <h4 className="text-[10px] font-bold uppercase tracking-widest text-[#1e295b]">ENTRY LOG <span className="text-[#d40000]">({activePaymentCount})</span></h4>
                    <button onClick={clearInstalments} className="text-[10px] font-bold uppercase tracking-widest text-red-600 hover:text-red-500">Clear All</button>
                  </div>
                  <div className="max-h-[240px] space-y-0.5 overflow-y-auto pr-1">
                    <AnimatePresence>
                      {activeDoc.transactions.filter((t) => t.type === 'Instalment Payment').map((txn, i) => (
                        <motion.div key={txn.id} initial={{opacity: 0, x: -10}} animate={{opacity: 1, x: 0}} exit={{opacity: 0, x: 10}}
                          className="group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-gray-100"
                        >
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-50 text-[10px] font-bold text-[#1e295b]">{i + 1}</span>
                          <span className="flex-1 font-mono text-[11px] text-gray-500">{formatDisplayDate(txn.date)}</span>
                          <span className="font-mono text-[11px] font-bold text-[#1e295b]">${formatMoney(txn.amount)}</span>
                          <button onClick={() => removeTransaction(txn.id)} className="rounded p-0.5 text-gray-300 opacity-0 transition-all hover:text-red-500 group-hover:opacity-100"><X size={11} /></button>
                        </motion.div>
                      ))}
                    </AnimatePresence>
                    {activePaymentCount === 0 && <p className="py-3 text-center text-[10px] italic text-gray-400">No payments recorded</p>}
                  </div>
                </Section>

                {/* Buttons */}
                <div className="space-y-2 pt-3">
                  <button onClick={() => { setView('output'); }} className="flex w-full items-center justify-center gap-2 rounded bg-[#1e295b] py-2.5 text-[10px] font-bold uppercase tracking-widest text-white shadow transition-all hover:bg-[#2a3a7b]">
                    <Eye size={14} /> View Statement
                  </button>
                  <button onClick={clearAllDocs} className="flex w-full items-center justify-center gap-2 rounded border border-red-200 bg-white py-2 text-[10px] font-bold uppercase tracking-widest text-red-600 transition-all hover:bg-red-50">
                    <Trash2 size={13} /> Clear All Data
                  </button>
                  <button onClick={() => setFactoryResetOpen(true)} className="flex w-full items-center justify-center gap-2 rounded border border-gray-200 bg-white py-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-500 transition-all hover:bg-gray-50">
                    <RotateCcw size={12} /> Factory Reset
                  </button>
                  {factoryResetOpen && (
                    <motion.div initial={{opacity: 0, y: -5}} animate={{opacity: 1, y: 0}} className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-center">
                      <p className="mb-2 text-[10px] text-gray-600">Reset all data to defaults?</p>
                      <div className="flex gap-2">
                        <button onClick={factoryReset} className="flex-1 rounded bg-red-600 py-1.5 text-[10px] font-bold text-white hover:bg-red-700">Yes</button>
                        <button onClick={() => setFactoryResetOpen(false)} className="flex-1 rounded bg-gray-200 py-1.5 text-[10px] font-bold text-gray-700 hover:bg-gray-300">Cancel</button>
                      </div>
                    </motion.div>
                  )}
                </div>
              </>
            )}
          </aside>

          {/* Main: Transaction table for active doc */}
          <main className="min-h-full bg-[#f7f7f5] p-6">
            {activeDoc && (
              <div className="mx-auto max-w-[860px]">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-sm font-black uppercase tracking-wider text-[#1e295b]">{activeDoc.client.name}</h2>
                  <span className="rounded-full bg-blue-50 px-3 py-1 text-[9px] font-bold uppercase tracking-wider text-blue-700">
                    {activeDoc.clientType} · Stand #{activeDoc.client.standNo}
                  </span>
                </div>

                <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                  <table className="w-full border-collapse text-[11px]">
                    <thead>
                      <tr className="border-b border-gray-200 bg-gray-50 text-[10px] font-bold uppercase text-gray-600">
                        <th className="border-r border-gray-200 p-2.5 text-center w-20">Date</th>
                        <th className="border-r border-gray-200 p-2.5 text-left">Details</th>
                        <th className="border-r border-gray-200 p-2.5 text-right w-22">Debit</th>
                        <th className="border-r border-gray-200 p-2.5 text-right w-22">Credit</th>
                        <th className="p-2.5 text-right w-26">Running Balance</th>
                        <th className="w-8 p-2.5"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {runningTxns.map((txn, i) => (
                        <tr key={txn.id} className={`border-b border-gray-100 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}`}>
                          <td className="border-r border-gray-100 p-2 text-center font-mono">{formatDisplayDate(txn.date)}</td>
                          <td className="border-r border-gray-100 p-2">{txn.type}</td>
                          <td className="border-r border-gray-100 p-2 text-right font-mono">{txn.direction === 'debit' && txn.amount > 0 ? `$${formatMoney(txn.amount)}` : '—'}</td>
                          <td className="border-r border-gray-100 p-2 text-right font-mono">{txn.direction === 'credit' && txn.amount > 0 ? `$${formatMoney(txn.amount)}` : '—'}</td>
                          <td className="p-2 text-right font-mono font-bold">${formatMoney(txn.runningBalance)}</td>
                          <td className="p-2 text-center">
                            <button onClick={() => removeTransaction(txn.id)} className="rounded p-0.5 text-gray-300 hover:text-red-500"><X size={11} /></button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-gray-300 bg-gray-50 font-bold text-[11px]">
                        <td colSpan={2} className="border-r border-gray-200 p-2 text-center uppercase tracking-wider text-gray-600">Total Debit</td>
                        <td className="border-r border-gray-200 p-2 text-right font-mono text-red-600">${formatMoney(totalDebit)}</td>
                        <td className="border-r border-gray-200 p-2"></td>
                        <td className="p-2"></td>
                        <td className="p-2"></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}
          </main>
        </div>
      )}

      {/* ── OUTPUT VIEW ── */}
      {view === 'output' && (
        <div className="min-h-[calc(100vh-56px)] bg-[#f7f7f5] p-6 print:bg-white print:p-0">
          <div className="mx-auto max-w-[860px] print:max-w-none">
            {/* Doc selector */}
            {docs.length > 1 && (
              <div className="mb-4 flex flex-wrap gap-2 no-print">
                {docs.map((doc) => (
                  <button
                    key={doc.id}
                    onClick={() => setActiveDocId(doc.id)}
                    className={`rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-all ${
                      doc.id === activeDocId ? 'bg-[#1e295b] text-white shadow-sm' : 'bg-white text-gray-600 border border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    {doc.client.name} #{doc.client.standNo}
                  </button>
                ))}
              </div>
            )}

            {activeDoc && (
              <div className="rounded-xl bg-white text-[#1a1a18] shadow-lg print:rounded-none print:shadow-none">
                <div className="p-8 print:p-6">
                  {/* Header */}
                  <div className="mb-6 flex items-start justify-between">
                    <div className="flex flex-col items-center">
                      <HouseLogoDark />
                      <div className="mt-3 text-center">
                        <h2 className="text-sm font-black uppercase tracking-[0.25em] text-[#1e295b]">Northgate</h2>
                        <p className="-mt-0.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[#1e295b]">Estates</p>
                        <p className="mt-1 font-serif text-[11px] italic text-[#1e295b]/60">Beyond a home!</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="mb-3 text-[13px] font-bold text-[#d40000]">
                        <span>Account Statement as of: </span>
                        <input type="date" value={activeDoc.statementDate} onChange={(e) => updateActiveDoc({statementDate: e.target.value})}
                          className="w-[170px] cursor-pointer border-b border-dashed border-red-300 bg-transparent py-0 text-[13px] font-bold text-[#d40000] outline-none hover:border-red-500 focus:border-red-500 focus:border-solid" />
                      </div>
                      <div className="space-y-1">
                        <EditableInfoLine label="Stand Number" value={activeDoc.client.standNo} onChange={(v) => updateActiveDoc({client: {...activeDoc.client, standNo: v}})} />
                        <EditableInfoLine label="Stand Size" value={`${activeDoc.client.standSize}`} suffix=" m²" type="number" onChange={(v) => updateActiveDoc({client: {...activeDoc.client, standSize: Number(v)}})} />
                        <EditableInfoLine label="Client Name" value={activeDoc.client.name} onChange={(v) => updateActiveDoc({client: {...activeDoc.client, name: v}})} />
                        <EditableInfoLine label="Client Contact" value={activeDoc.client.contact} onChange={(v) => updateActiveDoc({client: {...activeDoc.client, contact: v}})} />
                      </div>
                    </div>
                  </div>

                  {/* PDF badge */}
                  {uploadStatus && uploadStatus.includes('Loaded') && (
                    <div className="mb-4 flex items-center justify-center gap-2 no-print">
                      <span className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-[9px] font-bold uppercase tracking-wider text-blue-700">
                        Uploaded · {activeDoc.transactions.length} transactions
                      </span>
                    </div>
                  )}

                  {/* Summary */}
                  <div className="mb-6 overflow-hidden rounded-lg border border-gray-200">
                    <div className="grid grid-cols-4 border-b border-gray-200 bg-gray-50 text-[10px] font-bold uppercase text-gray-600">
                      <div className="border-r border-gray-200 p-3">Original Property Value (Incl. VAT)</div>
                      <div className="border-r border-gray-200 p-3">Total Amount Paid (USD)</div>
                      <div className="border-r border-gray-200 p-3">Monthly Instalment (Minimum)</div>
                      <div className="p-3">Loan Status</div>
                    </div>
                    <div className="grid grid-cols-4 text-[12px] font-bold">
                      <div className="border-r border-gray-200 p-3">${formatMoney(propertyValue)}</div>
                      <div className="border-r border-gray-200 p-3">${formatMoney(totalPaid)}</div>
                      <div className="border-r border-gray-200 p-3">{monthlyInstalment ? `$${formatMoney(monthlyInstalment)}` : '—'}</div>
                      <div className="p-3"><StatusBadge status={loanStatusResult.status} /></div>
                    </div>
                    <div className="grid grid-cols-4 border-t border-gray-200 text-[11px]">
                      <div className="border-r border-gray-200 bg-gray-50 p-3 font-bold text-gray-600">Revised Property Value (USD)</div>
                      <div className="border-r border-gray-200 p-3 font-bold">${formatMoney(propertyValue)}</div>
                      <div className="border-r border-gray-200 bg-gray-50 p-3 font-bold text-gray-600">{activeDoc.clientType}</div>
                      <div className="p-3 font-bold text-gray-600">{activeDoc.client.name}</div>
                    </div>
                  </div>

                  <div className="mb-6 text-center text-[10px] text-gray-500 italic">{loanStatusResult.detail}</div>

                  {/* Transaction table */}
                  <div className="mb-6 overflow-hidden rounded-lg border border-gray-200">
                    <table className="w-full border-collapse text-[11px]">
                      <thead>
                        <tr className="border-b border-gray-200 bg-gray-50 text-[10px] font-bold uppercase text-gray-600">
                          <th className="border-r border-gray-200 p-2.5 text-center w-24">Date</th>
                          <th className="border-r border-gray-200 p-2.5 text-left">Details</th>
                          <th className="border-r border-gray-200 p-2.5 text-right w-24">Debit (USD)</th>
                          <th className="border-r border-gray-200 p-2.5 text-right w-24">Credit (USD)</th>
                          <th className="p-2.5 text-right w-28">Running Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runningTxns.map((txn, i) => (
                          <tr key={txn.id} className={`border-b border-gray-100 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}`}>
                            <td className="border-r border-gray-100 p-2.5 text-center font-mono">{formatDisplayDate(txn.date)}</td>
                            <td className="border-r border-gray-100 p-2.5">{txn.type}</td>
                            <td className="border-r border-gray-100 p-2.5 text-right font-mono">{txn.direction === 'debit' && txn.amount > 0 ? `$${formatMoney(txn.amount)}` : '—'}</td>
                            <td className="border-r border-gray-100 p-2.5 text-right font-mono">{txn.direction === 'credit' && txn.amount > 0 ? `$${formatMoney(txn.amount)}` : '—'}</td>
                            <td className="p-2.5 text-right font-mono font-bold">${formatMoney(txn.runningBalance)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-gray-300 bg-gray-50 font-bold text-[11px]">
                          <td colSpan={2} className="border-r border-gray-200 p-2.5 text-center uppercase tracking-wider text-gray-600">Total Debit (USD)</td>
                          <td className="border-r border-gray-200 p-2.5 text-right font-mono text-red-600">${formatMoney(totalDebit)}</td>
                          <td className="border-r border-gray-200 p-2.5"></td>
                          <td className="p-2.5"></td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  {/* Amount remaining */}
                  <div className="mx-auto mb-6 max-w-[400px] rounded-lg border border-gray-200 text-center">
                    <div className="border-b border-gray-200 bg-gray-50 px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-gray-600">Amount Remaining (USD)</div>
                    <div className="px-6 py-5 font-mono text-2xl font-black tracking-tighter text-[#1e295b]">${formatMoney(lastBalance)}</div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center justify-center gap-3 no-print">
                    <button onClick={exportToExcel} className="flex items-center gap-2 rounded bg-[#1e295b] px-5 py-2.5 text-[10px] font-bold uppercase tracking-widest text-white shadow transition-all hover:bg-[#2a3a7b]">
                      <FileSpreadsheet size={15} /> Export Excel
                    </button>
                    <button onClick={() => window.print()} className="flex items-center gap-2 rounded bg-[#d40000] px-5 py-2.5 text-[10px] font-bold uppercase tracking-widest text-white shadow transition-all hover:bg-[#e60000]">
                      <Printer size={15} /> Print
                    </button>
                    <button onClick={() => setView('input')} className="flex items-center gap-2 rounded border border-gray-200 bg-white px-5 py-2.5 text-[10px] font-bold uppercase tracking-widest text-gray-600 transition-all hover:bg-gray-50">
                      <Edit3 size={14} /> Edit Data
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────
   SUB-COMPONENTS
   ────────────────────────────────────────────── */

function HouseLogo() {
  return (
    <svg width="26" height="26" viewBox="0 0 28 28" fill="none">
      <rect width="28" height="28" rx="4" fill="white" />
      <path d="M6 18 L14 8 L22 18" stroke="#1e295b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M10 16 L10 21 L18 21 L18 16" stroke="#1e295b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <line x1="12" y1="12" x2="12" y2="10" stroke="#1e295b" strokeWidth="1" /><line x1="14" y1="10" x2="14" y2="8" stroke="#1e295b" strokeWidth="1" /><line x1="16" y1="12" x2="16" y2="10" stroke="#1e295b" strokeWidth="1" />
    </svg>
  );
}

function HouseLogoDark() {
  return (
    <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
      <rect width="56" height="56" rx="8" fill="#1e295b" />
      <path d="M14 36 L28 16 L42 36" stroke="#d40000" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M20 32 L20 42 L36 42 L36 32" stroke="#d40000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <line x1="24" y1="24" x2="24" y2="20" stroke="white" strokeWidth="1.5" /><line x1="28" y1="20" x2="28" y2="16" stroke="white" strokeWidth="1.5" /><line x1="32" y1="24" x2="32" y2="20" stroke="white" strokeWidth="1.5" />
    </svg>
  );
}

function Section({title, children}: {title: string; children: ReactNode}) {
  return (
    <div className="mb-5">
      <h3 className="mb-2.5 border-b-2 border-blue-50 pb-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-[#1e295b]">{title}</h3>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

function Field({label, children}: {label: string; children: ReactNode}) {
  return (
    <div className="space-y-1">
      <label className="block text-[9px] font-bold uppercase tracking-wider text-gray-400">{label}</label>
      <div className="[&>input]:w-full [&>input]:rounded [&>input]:border [&>input]:border-gray-200 [&>input]:bg-gray-50 [&>input]:px-3 [&>input]:py-1.5 [&>input]:text-xs [&>input]:font-medium [&>input]:transition-all [&>input]:focus:border-[#1e295b] [&>input]:focus:outline-none [&>input]:focus:ring-1 [&>input]:focus:ring-blue-100 [&>select]:w-full [&>select]:rounded [&>select]:border [&>select]:border-gray-200 [&>select]:bg-gray-50 [&>select]:px-3 [&>select]:py-1.5 [&>select]:text-xs [&>select]:font-medium [&>select]:transition-all [&>select]:focus:border-[#1e295b] [&>select]:focus:outline-none [&>select]:focus:ring-1 [&>select]:focus:ring-blue-100">
        {children}
      </div>
    </div>
  );
}

function EditableInfoLine({label, value, onChange, type, suffix}: {label: string; value: string; onChange: (v: string) => void; type?: string; suffix?: string}) {
  return (
    <div className="flex items-baseline justify-end gap-8 text-[11px]">
      <span className="min-w-[110px] whitespace-nowrap text-right font-bold text-gray-800">{label}:</span>
      <span className="min-w-[120px] flex items-center justify-end gap-0.5 text-left font-medium text-gray-600">
        <input type={type || 'text'} value={value} onChange={(e) => onChange(e.target.value)}
          className="w-full max-w-[110px] border-b border-dashed border-gray-300 bg-transparent py-0 text-right text-[11px] font-medium text-gray-600 outline-none hover:border-gray-400 focus:border-[#1e295b] focus:border-solid" />
        {suffix && <span className="whitespace-nowrap">{suffix}</span>}
      </span>
    </div>
  );
}

function StatusBadge({status}: {status: string}) {
  const s = STATUS_STYLES[status] || STATUS_STYLES['On Track'];
  return (
    <span className="inline-block px-[10px] py-[2px] text-[12px] font-bold rounded-full" style={{backgroundColor: s.bg, color: s.text, borderColor: s.border, borderWidth: 1}}>
      {status}
    </span>
  );
}
