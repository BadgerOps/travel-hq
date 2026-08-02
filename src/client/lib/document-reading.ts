export type PassportReading = {
  documentNumber: string;
  expiry: string;
  nationality: string;
  dob: string;
};

export type DriversLicenseReading = {
  documentNumber: string;
  expiry: string;
  issuingJurisdiction: string;
  dob: string;
};

const MRZ_WEIGHTS = [7, 3, 1] as const;

function mrzValue(character: string): number {
  if (character === "<") return 0;
  if (/\d/.test(character)) return Number(character);
  if (/[A-Z]/.test(character)) return character.charCodeAt(0) - 55;
  return -1;
}

export function mrzCheckDigit(value: string): string {
  const total = [...value].reduce((sum, character, index) => {
    const numeric = mrzValue(character);
    if (numeric < 0) throw new Error("The machine-readable zone contains an invalid character.");
    return sum + numeric * MRZ_WEIGHTS[index % MRZ_WEIGHTS.length];
  }, 0);
  return String(total % 10);
}

function mrzDate(value: string, kind: "dob" | "expiry", today = new Date()): string {
  if (!/^\d{6}$/.test(value)) throw new Error("The machine-readable zone contains an invalid date.");
  const yy = Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  const currentYear = today.getUTCFullYear();
  let year: number;
  if (kind === "dob") {
    year = 2000 + yy > currentYear ? 1900 + yy : 2000 + yy;
  } else {
    year = 2000 + yy;
    if (year < currentYear - 20) year += 100;
  }
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new Error("The machine-readable zone contains an invalid date.");
  }
  return iso;
}

function normalizedMrzLines(text: string): string[] {
  return text
    .toUpperCase()
    .split(/\r?\n/)
    .map((line) => line.replace(/[ «]/g, "<").replace(/[^A-Z0-9<]/g, ""))
    .filter(Boolean);
}

export function parsePassportMrz(text: string, today = new Date()): PassportReading {
  const lines = normalizedMrzLines(text);
  const firstIndex = lines.findIndex((line) => line.startsWith("P<") && line.length >= 40);
  const first = firstIndex >= 0 ? lines[firstIndex]?.slice(0, 44) : undefined;
  const second = firstIndex >= 0 ? lines[firstIndex + 1]?.slice(0, 44) : undefined;
  if (!first || !second || first.length !== 44 || second.length !== 44) {
    throw new Error(
      "Could not find the passport's two machine-readable lines. Try a closer, sharper photo.",
    );
  }

  const checks: Array<[string, string, string]> = [
    [second.slice(0, 9), second[9]!, "document number"],
    [second.slice(13, 19), second[19]!, "date of birth"],
    [second.slice(21, 27), second[27]!, "expiry date"],
    [
      second.slice(0, 10) + second.slice(13, 20) + second.slice(21, 43),
      second[43]!,
      "composite",
    ],
  ];
  const failed = checks.find(([value, digit]) => mrzCheckDigit(value) !== digit);
  if (failed) {
    throw new Error(
      `The passport scan failed its ${failed[2]} check digit. Nothing was filled in; try another photo.`,
    );
  }

  return {
    documentNumber: second.slice(0, 9).replace(/<+$/g, ""),
    nationality: second.slice(10, 13).replace(/<+$/g, ""),
    dob: mrzDate(second.slice(13, 19), "dob", today),
    expiry: mrzDate(second.slice(21, 27), "expiry", today),
  };
}

function aamvaField(raw: string, code: string): string | undefined {
  const normalized = raw.replace(/\r/g, "\n").replace(/[\x1d\x1e]/g, "\n");
  const match = normalized.match(new RegExp(`(?:^|\\n)(?:DL|ID)?${code}([^\\n]+)`));
  return match?.[1]?.trim();
}

function aamvaDate(value: string, label: string): string {
  const digits = value.replace(/\D/g, "");
  let year: string;
  let month: string;
  let day: string;
  if (/^(19|20)\d{6}$/.test(digits)) {
    year = digits.slice(0, 4);
    month = digits.slice(4, 6);
    day = digits.slice(6, 8);
  } else if (/^\d{4}(19|20)\d{2}$/.test(digits)) {
    month = digits.slice(0, 2);
    day = digits.slice(2, 4);
    year = digits.slice(4, 8);
  } else {
    throw new Error(`The licence barcode has an unsupported ${label} date.`);
  }
  const iso = `${year}-${month}-${day}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day)
  ) {
    throw new Error(`The licence barcode has an invalid ${label} date.`);
  }
  return iso;
}

export function parseAamvaPdf417(raw: string): DriversLicenseReading {
  if (!raw.includes("ANSI ")) {
    throw new Error("This barcode is not an AAMVA driver's licence record.");
  }
  const documentNumber = aamvaField(raw, "DAQ");
  const expiry = aamvaField(raw, "DBA");
  const dob = aamvaField(raw, "DBB");
  const jurisdiction = aamvaField(raw, "DAJ") ?? aamvaField(raw, "DCG");
  if (!documentNumber || !expiry || !dob || !jurisdiction) {
    throw new Error(
      "The licence barcode is missing its number, expiry, birth date, or issuing jurisdiction.",
    );
  }
  return {
    documentNumber,
    expiry: aamvaDate(expiry, "expiry"),
    dob: aamvaDate(dob, "birth"),
    issuingJurisdiction: jurisdiction,
  };
}

type BarcodeDetectorResult = { rawValue: string };
type BarcodeDetectorInstance = { detect(source: ImageBitmap): Promise<BarcodeDetectorResult[]> };
type BarcodeDetectorConstructor = {
  new (options: { formats: string[] }): BarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
};

export async function supportsPdf417Format(): Promise<boolean> {
  const Detector = (
    globalThis as typeof globalThis & { BarcodeDetector?: BarcodeDetectorConstructor }
  ).BarcodeDetector;
  if (!Detector) return false;
  if (!Detector.getSupportedFormats) return true;
  return (await Detector.getSupportedFormats()).includes("pdf417");
}

export async function readDriversLicense(file: File): Promise<DriversLicenseReading> {
  const Detector = (
    globalThis as typeof globalThis & { BarcodeDetector?: BarcodeDetectorConstructor }
  ).BarcodeDetector;
  if (!Detector) {
    throw new Error("This browser cannot read licence barcodes. Enter the details manually.");
  }
  const bitmap = await createImageBitmap(file);
  try {
    const results = await new Detector({ formats: ["pdf417"] }).detect(bitmap);
    const result = results.find(({ rawValue }) => rawValue.includes("ANSI ")) ?? results[0];
    if (!result) {
      throw new Error(
        "No PDF417 barcode was found. Try a sharper photo of the back of the licence.",
      );
    }
    return parseAamvaPdf417(result.rawValue);
  } finally {
    bitmap.close();
  }
}

export async function readPassport(file: File): Promise<PassportReading> {
  // This import is intentionally inside the user action. Vite emits it as a
  // separate chunk, so neither the OCR runtime nor trained data is requested
  // on an ordinary profile-page load.
  const { createWorker, PSM } = await import("tesseract.js");
  const worker = await createWorker("eng", 1, {
    workerPath: "/assets/ocr/worker.min.js",
    corePath: "/assets/ocr",
    langPath: "/assets/ocr",
    logger: () => undefined,
  });
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<",
      preserve_interword_spaces: "1",
    });
    const { data } = await worker.recognize(file);
    return parsePassportMrz(data.text);
  } finally {
    await worker.terminate();
  }
}
