import { beforeAll, describe, expect, it, vi } from "bun:test";
import {
	createPetSelectItems,
	getPetUnavailableWarning,
	PET_UNAVAILABLE_WARNING,
} from "@sayknow-cli/coding-agent/modes/components/pet-capability";
import { PetSelectorComponent } from "@sayknow-cli/coding-agent/modes/components/pet-selector";
import { initTheme } from "@sayknow-cli/coding-agent/modes/theme/theme";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-octopus", "blue-octopus");
});

describe("PetSelectorComponent", () => {
	it("shows saved named pets but keeps unavailable ones unselectable", () => {
		const onSelect = vi.fn();
		const onPreview = vi.fn();
		const component = new PetSelectorComponent("red", onSelect, () => {}, onPreview, false);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("RedOctopus (saved)");
		expect(rendered).toContain("BlueOctopus");
		expect(rendered).toContain("Saved, unavailable");
		expect(stripAnsi(component.render(40).join("\n"))).toContain("RedOctopus (saved)");
		expect(component.getSelectList().getSelectedItem()?.value).toBe("off");

		component.getSelectList().handleInput("\x1b[B");
		expect(component.getSelectList().getSelectedItem()?.value).toBe("off");
		expect(onPreview).not.toHaveBeenCalled();
	});

	it("decorates settings options through the shared capability policy", () => {
		const items = createPetSelectItems(
			[
				{ value: "off", label: "Off" },
				{ value: "red", label: "RedOctopus" },
				{ value: "blue", label: "BlueOctopus" },
			],
			"blue",
			false,
		);

		expect(items.find(item => item.value === "off")?.disabled).toBe(false);
		expect(items.find(item => item.value === "red")?.disabled).toBe(true);
		expect(items.find(item => item.value === "blue")?.description).toContain("Saved, unavailable");
	});

	it("gives multiplexer-specific recovery guidance", () => {
		// tmux CAN carry graphics (DCS passthrough), so its warning names the real
		// requirement — a capable outer terminal — instead of telling users to leave.
		const tmuxWarning = getPetUnavailableWarning({ TMUX: "/tmp/tmux-1/default,1,0" });
		expect(tmuxWarning).toContain("passthrough");
		expect(tmuxWarning).toContain("Ghostty");
		expect(tmuxWarning).not.toContain("outside the multiplexer");
		// screen/zellij have no passthrough envelope: leaving is the only fix.
		expect(getPetUnavailableWarning({ ZELLIJ: "session" })).toContain("outside the multiplexer");
		expect(getPetUnavailableWarning({})).toBe(PET_UNAVAILABLE_WARNING);
	});
});
