import { describe, it, expect } from "vitest";
import { trimIndentation } from "./test-utils.js";

describe("Utils", () => {
    it("trims indentation", () => {
        expect(trimIndentation`\
            Hello
                world
            123`).toBe(`\
Hello
    world
123`);
    });
});
