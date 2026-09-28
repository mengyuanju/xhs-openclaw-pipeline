export type QaPreviousReturn = {
  reasonLabels: string[];
  note: string | null;
  returnedAt: string | null;
};

export type ImageQaPreviousReturn = QaPreviousReturn & {
  reworkTarget: 'IMAGE' | 'COPY' | 'BOTH' | null;
  problemPages: number[];
  copyFields: string[];
};

export function normalizeQaPreviousReturn(value: unknown): QaPreviousReturn | null;
export function normalizeImageQaPreviousReturn(value: unknown): ImageQaPreviousReturn | null;
