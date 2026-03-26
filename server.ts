import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import multer from "multer";
import Database from "better-sqlite3";
import axios from "axios";
import archiver from "archiver";
import FormData from "form-data";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import { generateAllPdfs, type PdfResult } from "./pdfGenerator.js";
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(cookieParser());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// --- DATABASE SETUP ---
const db = new Database("towdoc_v2.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    data TEXT,
    status TEXT,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    jobId TEXT,
    fieldName TEXT,
    path TEXT,
    originalName TEXT,
    mimeType TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// --- STORAGE SETUP ---
const UPLOAD_PATH = path.resolve(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_PATH)) {
  fs.mkdirSync(UPLOAD_PATH, { recursive: true });
}

const storage = multer.diskStorage({
  destination: UPLOAD_PATH,
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const sanitizedFieldname = file.fieldname.replace(/[^a-z0-9]/gi, '_');
    cb(null, `${sanitizedFieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB
});

// --- FILE LABELS: Mapping fieldName → ZIP filename (photos + signatures) ---
const FILE_LABELS: Record<string, string> = {
  // Photos
  arrival:             "Fotos/Ankunft_Situation",
  plate:               "Fotos/Kennzeichen_VIN",
  cockpit:             "Fotos/Cockpit_KM-Stand",
  front:               "Fotos/Fahrzeug_Frontal",
  right:               "Fotos/Fahrzeug_Rechts",
  left:                "Fotos/Fahrzeug_Links",
  rear:                "Fotos/Fahrzeug_Heck",
  plateau:             "Fotos/Verladen_Plateau",
  other:               "Fotos/Sonstiges",
  parked:              "Fotos/Abstellort",
  Karosserie_dmg:      "Vorschaeden/Vorschaden_Karosserie",
  Verglasung_dmg:      "Vorschaeden/Vorschaden_Verglasung",
  Reifen_Felgen_dmg:   "Vorschaeden/Vorschaden_Reifen_Felgen",
  Beleuchtung_dmg:     "Vorschaeden/Vorschaden_Beleuchtung",
  Besonderheiten_dmg:  "Vorschaeden/Vorschaden_Besonderheiten",
  // Signatures — fieldNames used by the app (Sigs: type+'_sig', Service: type)
  privacy_sig:         "Unterschriften/Datenschutz_Unterschrift_Kunde",
  order_sig:           "Unterschriften/Auftragsbestaetigung_Unterschrift_Kunde",
  liability:           "Unterschriften/Haftungsausschluss_Unterschrift_Kunde",
  liabilityDriver:     "Unterschriften/Haftungsausschluss_Unterschrift_Fahrer",
};

function buildJobZip(files: any[], pdfs: PdfResult[] = []): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const arc = archiver("zip", { zlib: { level: 6 } });
    const chunks: Buffer[] = [];
    arc.on("data", (chunk: Buffer) => chunks.push(chunk));
    arc.on("end", () => resolve(Buffer.concat(chunks)));
    arc.on("error", reject);

    const zipContents: string[] = [];

    // ── Photos & Signatures (uploaded files) ────────────────────────────────
    const counters: Record<string, number> = {};
    for (const file of files) {
      const label = FILE_LABELS[file.fieldName];
      if (!label) continue; // skip unknown fields
      const fullPath = path.join(UPLOAD_PATH, path.basename(file.path));
      if (!fs.existsSync(fullPath)) {
        console.log(`[ZIP] Datei nicht gefunden, übersprungen: ${file.fieldName}`);
        continue;
      }
      counters[file.fieldName] = (counters[file.fieldName] || 0) + 1;
      const n = counters[file.fieldName];
      const extFromName = path.extname(file.originalName);
      const extFromMime = file.mimeType === "image/png" ? ".png" : ".jpg";
      const ext = extFromName || extFromMime;
      const filename = n > 1 ? `${label}_${n}${ext}` : `${label}${ext}`;
      arc.file(fullPath, { name: filename });
      zipContents.push(filename);
    }

    // ── PDF Documents ────────────────────────────────────────────────────────
    for (const pdf of pdfs) {
      const zipName = `Dokumente/${pdf.name}`;
      arc.append(pdf.buffer, { name: zipName });
      console.log(`[ZIP] PDF hinzugefügt: ${zipName}`);
      zipContents.push(zipName);
    }

    console.log(`[ZIP] Inhalt gesamt (${zipContents.length} Dateien): ${zipContents.join(", ") || "leer"}`);
    arc.finalize();
  });
}

// --- DOCUMENT STATUS ---

type DocStatus = { name: string; available: boolean; reason: string };

function computeDocumentStatus(d: any): DocStatus[] {
  const absent = (): string => {
    if (d.customerCrashed)    return "Kunde verunfallt / nicht ansprechbar";
    if (d.refusedSignature)   return "Unterschrift verweigert (KVU)";
    if (d.isCustomerPresent === false) return "Kunde nicht vor Ort";
    if (d.waivedSignature)    return "Unterschrift verzichtet";
    return "Unterschrift fehlt";
  };

  const docs: DocStatus[] = [];

  // Datenschutzerklärung — benötigt signatures.privacy
  const privOk = !!d.signatures?.privacy;
  docs.push({ name: "Datenschutzerklärung",  available: privOk,  reason: privOk  ? "Unterschrift vorhanden" : absent() });

  // Auftragsbestätigung — benötigt signatures.order
  const ordOk = !!d.signatures?.order;
  docs.push({ name: "Auftragsbestätigung",   available: ordOk,   reason: ordOk   ? "Unterschrift vorhanden" : absent() });

  // Haftungsausschluss — nur bei Notöffnung, benötigt liability + liabilityDriver
  if (d.serviceType === "notoeffnung") {
    const liabOk = !!d.signatures?.liability && !!d.signatures?.liabilityDriver;
    docs.push({
      name: "Haftungsausschluss",
      available: liabOk,
      reason: liabOk
        ? "Beide Unterschriften vorhanden"
        : d.waivedSignature
          ? (d.refusedSignature ? "Unterschrift verweigert (KVU)" : "Unterschrift verzichtet")
          : "Unterschrift(en) fehlen",
    });
  }

  return docs;
}

function docStatusRow(doc: DocStatus): string {
  const icon  = doc.available ? "✓" : "✗";
  const color = doc.available ? "#16a34a" : "#dc2626";
  return `<tr>
    <td style="padding:6px 14px;color:#888;font-weight:600;white-space:nowrap;border-bottom:1px solid #f0f0f0">${doc.name}</td>
    <td style="padding:6px 14px;border-bottom:1px solid #f0f0f0">
      <span style="color:${color};font-weight:900">${icon}</span>
      <span style="font-weight:700;margin-left:6px;color:${color}">${doc.reason}</span>
    </td>
  </tr>`;
}

function tr(label: string, value: any): string {
  const v = value !== undefined && value !== null && value !== "" ? String(value) : "–";
  return `<tr><td style="padding:6px 14px;color:#888;font-weight:600;white-space:nowrap;border-bottom:1px solid #f0f0f0">${label}</td><td style="padding:6px 14px;font-weight:700;border-bottom:1px solid #f0f0f0">${v}</td></tr>`;
}

function sec(title: string, rows: string): string {
  return `<tr><td colspan="2" style="padding:14px 14px 4px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.1em;color:#FF6321;background:#fff9f6">${title}</td></tr>${rows}`;
}

function buildEmailHtml(d: any, docStatus: DocStatus[]): string {
  const company = d.company === "swientek-glaeser" ? "Swientek & Gläser GmbH" : "Auto-Misselwitz GmbH";
  const serviceLabel = d.serviceType === "transport" ? "Transport" : d.serviceType === "pannenhilfe" ? "Pannenhilfe" : "Notöffnung";
  const fmtTs = (iso?: string) =>
    iso ? new Date(iso).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "–";
  const preDmg = Object.entries(d.preDamages || {})
    .filter(([, v]: any) => v.isDefect)
    .map(([k, v]: any) => `${k}${v.note ? ": " + v.note : ""}`)
    .join(", ") || "Keine";
  const destFull = [d.destStreet, d.destHouseNum, d.destZip, d.destCity].filter(Boolean).join(" ");

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:system-ui,sans-serif;background:#f5f5f5;margin:0;padding:20px">
<div style="max-width:620px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
  <div style="background:#FF6321;padding:24px 28px;color:#fff">
    <div style="font-size:11px;font-weight:900;letter-spacing:0.15em;opacity:0.75;text-transform:uppercase">AppSchleppen – Einsatzdokumentation</div>
    <div style="font-size:22px;font-weight:900;margin-top:4px">${d.orderId || d.id}</div>
    <div style="font-size:13px;opacity:0.85;margin-top:2px">${company}</div>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    ${sec("Auftrag", [
      tr("Auftragsnummer", d.orderId),
      tr("Datum", fmtTs(d.timestamps?.accepted)),
      tr("Unternehmen", company),
      tr("Fahrer", d.driverName),
      tr("Einsatzfahrzeug", d.driverVehicle),
    ].join(""))}
    ${sec("Kundenfahrzeug", [
      tr("Kennzeichen", d.licensePlate),
      tr("Fahrzeugmodell", d.vehicleModel),
      tr("Halter / Eigentümer", d.ownerName),
      tr("Auftraggeber", d.customerDriverName),
      tr("Telefon", d.phone),
      tr("E-Mail", d.customerEmail),
    ].join(""))}
    ${sec("Einsatz", [
      tr("Dienstleistung", serviceLabel),
      tr("Einsatzort", [d.address, d.zip, d.city].filter(Boolean).join(" ")),
      tr("Schwerer Unfall", d.isSevereAccident ? "Ja" : "Nein"),
      tr("Kunden-Status", d.kundeDa),
    ].join(""))}
    ${d.serviceType !== "transport" ? sec("Service-Details", [
      d.serviceType === "pannenhilfe" ? tr("Weiterfahrt möglich", d.continueJourneyPossible === true ? "Ja" : d.continueJourneyPossible === false ? "Nein" : "–") : "",
      d.serviceType === "pannenhilfe" ? tr("Pannenhilfe-Notiz", d.serviceNotes) : "",
      d.serviceType === "notoeffnung" ? tr("Identität geprüft", d.identityChecked ? "Ja" : "Nein") : "",
      d.serviceType === "notoeffnung" ? tr("Wie Hilfe geleistet", d.liabilityHelp) : "",
      tr("KVU / Unterschrift verzichtet", d.waivedSignature ? "Ja" : "Nein"),
    ].join("")) : ""}
    ${d.destinationType ? sec("Zielort", [
      tr("Zielort-Typ", d.destinationType),
      tr("Name", d.destName),
      tr("Adresse", destFull),
      tr("Kunde mitgefahren", d.customerTravelingAlong === true ? "Ja" : d.customerTravelingAlong === false ? "Nein" : "–"),
    ].join("")) : ""}
    ${sec("Dokumentenstatus", docStatus.map(docStatusRow).join(""))}
    ${sec("Dokumentation", [
      tr("Vorschäden", preDmg),
      tr("Büro-Notiz", d.officeNotes || (d.noSpecialNotes ? "Keine Besonderheiten" : "–")),
    ].join(""))}
    ${sec("Zeitstempel", [
      tr("Angenommen", fmtTs(d.timestamps?.accepted)),
      tr("Auf dem Weg", fmtTs(d.timestamps?.enRoute)),
      tr("Ankunft am Schadenort", fmtTs(d.timestamps?.arrived)),
      tr("Dokumentation gestartet", fmtTs(d.timestamps?.documenting)),
      tr("Auf dem Weg zum Zielort", fmtTs(d.timestamps?.transport)),
      tr("Zielort erreicht", fmtTs(d.timestamps?.atDest)),
    ].join(""))}
  </table>
  <div style="padding:16px 28px;background:#f9f9f9;font-size:11px;color:#aaa;border-top:1px solid #eee">
    Automatisch generiert von AppSchleppen · ${new Date().toLocaleDateString("de-DE")}
  </div>
</div>
</body></html>`;
}

async function sendJobSummaryEmail(jobData: any, files: any[], pdfs: PdfResult[] = []): Promise<void> {
  const host = process.env.SMTP_HOST;
  const officeEmail = process.env.OFFICE_EMAIL;
  if (!host || !officeEmail) {
    console.log("Email skipped: SMTP_HOST or OFFICE_EMAIL not configured.");
    return;
  }

  const transporter = nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  // Compute document status before building email
  const docStatus = computeDocumentStatus(jobData);

  // ZIP: photos + signatures + PDFs
  const knownFiles = files.filter((f) => FILE_LABELS[f.fieldName]);
  const attachments: any[] = [];

  if (knownFiles.length > 0 || pdfs.length > 0) {
    const zipBuffer = await buildJobZip(knownFiles, pdfs);
    const orderId = jobData.orderId || jobData.id;
    attachments.push({
      filename: `Einsatz_${orderId}.zip`,
      content: zipBuffer,
      contentType: "application/zip",
    });
  }

  const orderId = jobData.orderId || jobData.id;
  const companyShort = jobData.company === "swientek-glaeser" ? "Swientek & Gläser" : "Auto-Misselwitz";

  await transporter.sendMail({
    from: process.env.SMTP_FROM || `"AppSchleppen" <${process.env.SMTP_USER}>`,
    to: officeEmail,
    subject: `Einsatz abgeschlossen: ${orderId} – ${companyShort}`,
    html: buildEmailHtml(jobData, docStatus),
    attachments,
  });
}

// --- API ROUTES ---

app.get("/api/jobs/:id", (req, res) => {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(req.params.id) as any;
  if (!job) return res.status(404).json({ error: "Not found" });
  
  const files = db.prepare("SELECT * FROM files WHERE jobId = ?").all(req.params.id);
  res.json({ ...job, data: JSON.parse(job.data), files });
});

app.post("/api/jobs", (req, res) => {
  const { id, data, status } = req.body;
  const stmt = db.prepare(`
    INSERT INTO jobs (id, data, status) 
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET 
      data = excluded.data, 
      status = excluded.status,
      updatedAt = CURRENT_TIMESTAMP
  `);
  stmt.run(id, JSON.stringify(data), status);
  res.json({ success: true });
});

app.post("/api/upload/:jobId", (req, res) => {
  const { jobId } = req.params;
  
  upload.any()(req, res, (err) => {
    if (err) {
      console.error("Upload Error:", err);
      return res.status(500).json({ error: err.message });
    }

    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) return res.status(400).json({ error: "No files" });

    try {
      const stmt = db.prepare("INSERT INTO files (id, jobId, fieldName, path, originalName, mimeType) VALUES (?, ?, ?, ?, ?, ?)");
      const results = files.map(file => {
        const fileId = Math.random().toString(36).substring(7);
        const relativePath = `/uploads/${path.basename(file.path)}`;
        stmt.run(fileId, jobId, file.fieldname, relativePath, file.originalname, file.mimetype);
        return { id: fileId, fieldName: file.fieldname, path: relativePath };
      });
      res.json(results);
    } catch (dbErr: any) {
      console.error("DB Error:", dbErr);
      res.status(500).json({ error: dbErr.message });
    }
  });
});

app.use("/uploads", express.static(UPLOAD_PATH));

app.post("/api/jobs/:id/complete", async (req, res) => {
  const { id } = req.params;
  const jobRow = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as any;
  if (!jobRow) return res.status(404).json({ error: "Job not found" });

  const files = db.prepare("SELECT * FROM files WHERE jobId = ?").all(id) as any[];

  // 1. Trigger n8n webhook
  const webhookUrl = process.env.WEBHOOK_URL || "https://n8n.srv1130396.hstgr.cloud/webhook/dd3205b3-9acd-43c5-8b62-5d19eafa6149";
  const jobData = JSON.parse(jobRow.data);
  const docStatus = computeDocumentStatus(jobData);
  const form = new FormData();
  form.append("payload", jobRow.data);
  form.append("event", "form.completed");
  form.append("sentAt", new Date().toISOString());
  // Tell n8n which documents can be generated (only generate PDFs when data+signatures are available)
  form.append("documentStatus", JSON.stringify(docStatus));

  console.log(`Preparing webhook for job ${id}. Files to attach: ${files.length}`);
  for (const file of files) {
    const fullPath = path.join(UPLOAD_PATH, path.basename(file.path));
    if (fs.existsSync(fullPath)) {
      console.log(`Attaching file: ${file.fieldName} (${file.originalName})`);
      form.append(file.fieldName, fs.createReadStream(fullPath), { 
        filename: file.originalName, 
        contentType: file.mimeType 
      });
    } else {
      console.warn(`File not found on disk: ${fullPath}`);
    }
  }

  try {
    console.log(`Sending webhook for job ${id} to ${webhookUrl}...`);
    const response = await axios.post(webhookUrl, form, { 
      headers: form.getHeaders(), 
      timeout: 60000 // Increased timeout for large uploads
    });
    console.log("Webhook successfully sent for job:", id, "Response:", response.status);

    // 2. Generate PDFs (before file cleanup — signatures must still be on disk)
    let pdfs: PdfResult[] = [];
    try {
      pdfs = await generateAllPdfs(jobData);
    } catch (pdfErr: any) {
      console.error(`[PDF] Unerwarteter Fehler bei PDF-Generierung für Job ${id}:`, pdfErr.message);
    }

    // 3. Send summary email with ZIP (photos + signatures + PDFs)
    try {
      await sendJobSummaryEmail(jobData, files, pdfs);
      console.log("Summary email sent for job:", id);
    } catch (emailErr: any) {
      console.error("Email sending failed for job:", id, emailErr.message);
      // Non-fatal: log and continue — job is still marked complete
    }

    // 4. Cleanup local files after successful webhook + email
    for (const file of files) {
      const fullPath = path.join(UPLOAD_PATH, path.basename(file.path));
      if (fs.existsSync(fullPath)) {
        try {
          fs.unlinkSync(fullPath);
          console.log("Deleted local file:", fullPath);
        } catch (unlinkErr: any) {
          console.error("Error deleting file:", unlinkErr.message);
        }
      }
    }
    
    // 3. Cleanup database: Remove file records and clear photo data from job
    db.prepare("DELETE FROM files WHERE jobId = ?").run(id);
    
    const currentData = jobData;
    // Clear photos, preDamages photos, and signatures to save space and respect privacy/cleanup
    const cleanedData = {
      ...currentData,
      photos: {},
      preDamages: Object.fromEntries(
        Object.entries(currentData.preDamages || {}).map(([key, val]: [string, any]) => [
          key, 
          { ...val, photos: [] }
        ])
      ),
      signatures: { driver: '', customer: '' }
    };

    db.prepare("UPDATE jobs SET status = 'Abgeschlossen (Exportiert)', data = ? WHERE id = ?")
      .run(JSON.stringify(cleanedData), id);

    console.log(`Database cleanup completed for job ${id}. File records removed and photo data cleared.`);
    res.json({ success: true });
  } catch (e: any) {
    console.error("Webhook failed for job:", id, "Error:", e.message);
    let details = e.message;
    if (e.response) {
      console.error("Webhook response error data:", e.response.data);
      details = typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data);
    }
    res.status(500).json({ 
      error: "Webhook Export fehlgeschlagen", 
      details: `Der n8n Webhook konnte nicht erreicht werden oder hat einen Fehler gemeldet: ${details}. Die Fotos wurden lokal gespeichert, aber der Export in das Backoffice ist fehlgeschlagen.` 
    });
  }
});

app.get("/api/admin/jobs", (req, res) => {
  const jobs = db.prepare("SELECT * FROM jobs ORDER BY updatedAt DESC").all();
  res.json(jobs.map((j: any) => ({ ...j, data: JSON.parse(j.data) })));
});

app.get("/api/admin/export/:id", async (req, res) => {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(req.params.id) as any;
  if (!job) return res.status(404).send("Not found");

  const files = db.prepare("SELECT * FROM files WHERE jobId = ?").all(req.params.id) as any[];
  
  res.attachment(`Auto-Misselwitz-${req.params.id}.zip`);
  const archive = archiver("zip");
  archive.pipe(res);
  archive.append(job.data, { name: "data.json" });

  for (const file of files) {
    const fullPath = path.join(UPLOAD_PATH, path.basename(file.path));
    if (fs.existsSync(fullPath)) {
      archive.file(fullPath, { name: `files/${file.fieldName}-${file.originalName}` });
    }
  }
  await archive.finalize();
});

async function start() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
    app.get("*", (req, res) => res.sendFile(path.resolve("dist/index.html")));
  }
  app.listen(PORT, "0.0.0.0", () => console.log(`Server on http://localhost:${PORT}`));
}

start();
