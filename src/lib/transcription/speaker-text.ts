/** One speaker turn of a transcript supplied by an external tool. */
export interface SpeakerSegment {
    speaker: string;
    text: string;
    /** Offset from the start of the recording, in seconds. */
    start?: number;
}

/** Longest speaker name `SpeakerTranscript` renders as a label. */
export const SPEAKER_NAME_MAX_LENGTH = 40;

/** Characters a speaker name may not contain (they would break the label). */
export const SPEAKER_NAME_FORBIDDEN = /[:\n\r[\]?!;"]/;

/** `mm:ss`, or `hh:mm:ss` from one hour on. */
export function formatTimestamp(seconds: number): string {
    const wholeSeconds = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(wholeSeconds / 3600);
    const minutes = Math.floor((wholeSeconds % 3600) / 60);
    const remainingSeconds = wholeSeconds % 60;
    const minuteText = String(minutes).padStart(2, "0");
    const secondText = String(remainingSeconds).padStart(2, "0");

    return hours > 0
        ? `${String(hours).padStart(2, "0")}:${minuteText}:${secondText}`
        : `${minuteText}:${secondText}`;
}

/**
 * Flatten speaker segments into one `Name: text` line per turn, prefixed
 * with `[mm:ss] ` when the segment has a `start`. This is the format
 * `SpeakerTranscript` renders by speaker. Line breaks inside a segment's
 * text are folded into spaces so every turn stays on one line.
 */
export function formatSpeakerSegments(segments: SpeakerSegment[]): string {
    return segments
        .map((segment) => {
            const speaker = segment.speaker.trim();
            const text = segment.text.replace(/\s+/g, " ").trim();
            const prefix =
                segment.start === undefined
                    ? ""
                    : `[${formatTimestamp(segment.start)}] `;
            return `${prefix}${speaker}: ${text}`;
        })
        .join("\n");
}
