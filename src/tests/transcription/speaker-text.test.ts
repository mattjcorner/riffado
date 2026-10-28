// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { SpeakerTranscript } from "@/components/recordings/rich-content";
import {
    formatSpeakerSegments,
    formatTimestamp,
} from "@/lib/transcription/speaker-text";

function turnLabels(text: string): string[] {
    const { container } = render(createElement(SpeakerTranscript, { text }));
    return [...container.querySelectorAll(":scope > div > div")].map(
        (turn) => turn.querySelector("span")?.textContent ?? "",
    );
}

describe("formatSpeakerSegments", () => {
    it("writes one labelled line per segment", () => {
        expect(
            formatSpeakerSegments([
                { speaker: " Alice ", text: "Hello\n  everyone." },
                { speaker: "Bob", text: "Hi." },
            ]),
        ).toBe("Alice: Hello everyone.\nBob: Hi.");
    });

    it("prefixes a timestamp when a segment has a start", () => {
        expect(
            formatSpeakerSegments([
                { speaker: "Alice", text: "Hello.", start: 5.9 },
                { speaker: "Bob", text: "Hi.", start: 3725 },
            ]),
        ).toBe("[00:05] Alice: Hello.\n[01:02:05] Bob: Hi.");
        expect(formatTimestamp(0)).toBe("00:00");
    });
});

describe("SpeakerTranscript with named speakers", () => {
    it("renders formatted segments by speaker", () => {
        const text = formatSpeakerSegments([
            { speaker: "Alice", text: "Budget first.", start: 0 },
            { speaker: "Dr. Bob Smith", text: "Agreed.", start: 12 },
            { speaker: "Alice", text: "Then hiring.", start: 30 },
        ]);
        const { container } = render(
            createElement(SpeakerTranscript, { text }),
        );

        const turns = [...container.querySelectorAll(":scope > div > div")];
        expect(turns.map((t) => t.querySelector("span")?.textContent)).toEqual([
            "[00:00] Alice:",
            "[00:12] Dr. Bob Smith:",
            "[00:30] Alice:",
        ]);
        expect(turns[1].textContent).toContain("Agreed.");
        const colour = (i: number) =>
            turns[i].querySelector("span")?.className ?? "";
        expect(colour(0)).toBe(colour(2));
        expect(colour(0)).not.toBe(colour(1));
    });

    it("renders untimed named lines by speaker", () => {
        expect(turnLabels("Alice: one\nBob: two")).toEqual(["Alice:", "Bob:"]);
    });

    it("keeps a transcript plain unless every line is labelled", () => {
        expect(turnLabels("Alice: one\nand then some prose")).toEqual([]);
        expect(turnLabels("Note: a single line")).toEqual([]);
    });

    it("still parses a Plaud transcript with a renamed speaker", () => {
        expect(turnLabels("Speaker 1: hello\nAlice: hi")).toEqual([
            "Speaker 1:",
            "Alice:",
        ]);
    });
});
