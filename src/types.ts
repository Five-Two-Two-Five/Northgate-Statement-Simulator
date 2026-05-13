export enum ClientType {
  NON_STAFF = 'Non-Staff',
  STAFF = 'Staff',
}

export type TransactionDirection = 'credit' | 'debit' | 'none';

export type TransactionType =
  | 'Instalment Payment'
  | 'Interest Accrued'
  | 'Booking Fee'
  | 'Property Value'
  | 'Manual Adjustment';

export type LoanStatus =
  | 'Paid Off'
  | 'In Arrears'
  | 'Behind'
  | 'On Track'
  | 'Ahead'
  | 'New Account';

export interface Transaction {
  id: string;
  date: string;
  type: TransactionType;
  direction: TransactionDirection;
  amount: number;
  runningBalance: number;
}

export interface ClientInfo {
  name: string;
  standNo: string;
  standSize: number;
  contact: string;
}

export interface ParsedPDF {
  client: ClientInfo;
  propertyValue: number;
  totalPaid: number;
  monthlyInstalment: number;
  loanStatus: string;
  transactions: Transaction[];
}

export interface ValidationResult {
  field: string;
  pdfValue: number;
  calculatedValue: number;
  status: 'match' | 'tolerance' | 'mismatch';
}

export interface AmortisationRow {
  month: number;
  date: string;
  interest: number;
  principal: number;
  balance: number;
}

export interface LoanStatusResult {
  status: LoanStatus;
  detail: string;
}

export interface UploadedDoc {
  id: string;
  client: ClientInfo;
  clientType: ClientType;
  deposit: number;
  loanTerm: number;
  statementDate: string;
  transactions: Transaction[];
  propertyValue: number;
  totalPaid: number;
}

export interface ParsedRTF {
  client: ClientInfo;
  propertyValue: number;
  totalPaid: number;
  monthlyInstalment: number;
  loanStatus: string;
  transactions: Transaction[];
}
