import { mkdirSync, appendFileSync } from "fs";


const LOG_DIR = "logs";
mkdirSync(LOG_DIR, { recursive:true });

export function mondayOf(date: Date): string {
    const daysBack = (date.getUTCDay() + 6) % 7;
    const monday = new Date(date);
    monday.setUTCDate(monday.getUTCDate() - daysBack);
    return monday.toISOString().slice(0,10);
}

function fileFor(date: Date): string {
    return `${LOG_DIR}/requests-${mondayOf(date)}.jsonl`;
}

export function logRequest(entry: Record<string, unknown>): void {
    const now = new Date()
    const line = JSON.stringify({ ts: now.toISOString(), ...entry });
    console.log(line);
    appendFileSync(fileFor(now), line + "\n")
}