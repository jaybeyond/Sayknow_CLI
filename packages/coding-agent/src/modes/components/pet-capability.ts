import {
	getOverlayImageProtocol,
	ImageProtocol,
	isUnderTerminalMultiplexer,
	isUnderTmux,
	onImageProtocolChanged,
	type SelectItem,
	shouldProbeKittyPassthrough,
	shouldProbeSixelCapability,
} from "@sayknow-cli/tui";

export type PetPixelProtocol = "sixel" | "kitty";

export const PET_UNAVAILABLE_DESCRIPTION = "Unavailable: requires compatible Kitty or Sixel overlay rendering";
export const PET_SAVED_UNAVAILABLE_DESCRIPTION =
	"Saved, unavailable — requires compatible Kitty or Sixel overlay rendering";
export const PET_UNAVAILABLE_WARNING =
	"⚠ Pets aren’t available in this terminal. Its image support isn’t compatible with Sayknow Pet’s overlay rendering yet. Try Kitty, Ghostty, WezTerm, or a terminal with compatible Sixel support.";
const PET_TMUX_UNAVAILABLE_WARNING =
	"⚠ Sayknow Pet graphics are unavailable: the terminal attached to this tmux client answered neither the Kitty nor the Sixel capability query forwarded through DCS passthrough. Attach from Ghostty, Kitty, WezTerm, or a Sixel-capable terminal, and leave tmux `allow-passthrough` enabled.";
const PET_MULTIPLEXER_UNAVAILABLE_WARNING =
	"⚠ Sayknow Pet graphics are unavailable inside screen and zellij: neither forwards image escapes to the outer terminal. Run skc under tmux (which has DCS passthrough) or outside the multiplexer.";

export function getPetUnavailableWarning(env: NodeJS.ProcessEnv = Bun.env): string {
	if (isUnderTmux(env)) return PET_TMUX_UNAVAILABLE_WARNING;
	return isUnderTerminalMultiplexer(env) ? PET_MULTIPLEXER_UNAVAILABLE_WARNING : PET_UNAVAILABLE_WARNING;
}

export function getPetPixelProtocol(): PetPixelProtocol | null {
	// Overlay channel: inline graphics when the terminal renders them directly,
	// otherwise the tmux passthrough protocol proven by the startup probe.
	const protocol = getOverlayImageProtocol();
	if (protocol === ImageProtocol.Kitty) return "kitty";
	if (protocol === ImageProtocol.Sixel) return "sixel";
	return null;
}

export function isPetAvailable(): boolean {
	return getPetPixelProtocol() !== null;
}

export function createPetSelectItems(
	options: ReadonlyArray<SelectItem>,
	currentValue: string,
	available: boolean,
): SelectItem[] {
	return options.map(option => {
		const disabled = !available && option.value !== "off";
		const current = option.value === currentValue;
		const savedUnavailable = disabled && current;
		let description = `${option.description ?? ""}${current ? " (current)" : ""}`;
		if (disabled) {
			description = savedUnavailable ? PET_SAVED_UNAVAILABLE_DESCRIPTION : PET_UNAVAILABLE_DESCRIPTION;
		}
		return {
			...option,
			label: savedUnavailable ? `${option.label} (saved)` : option.label,
			description,
			disabled,
		};
	});
}

/**
 * Grace period before declaring the terminal pet-incapable at startup. The
 * asynchronous capability probes start inside `TUI.start()` and answer within
 * their own deadline (250 ms directly, 600 ms through tmux passthrough); this
 * margin covers probe scheduling so a supported terminal is never told it is
 * incompatible while a probe is still in flight.
 */
export const PET_CAPABILITY_SETTLE_MS = 1_500;

/**
 * Whether an asynchronous startup capability probe (Sixel, or Kitty through
 * tmux passthrough) may still enable graphics for this session, meaning current
 * unavailability is not final.
 */
export function isPetCapabilityProbePending(
	env: NodeJS.ProcessEnv = Bun.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (getPetPixelProtocol() !== null) return false;
	if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
	return shouldProbeSixelCapability(env, platform) || shouldProbeKittyPassthrough(env);
}

/**
 * Deliver the pet-unavailable startup warning only once the capability
 * question is settled. With no probe pending, unavailability is final and
 * `onUnavailable` fires immediately. While a probe may still enable
 * graphics, the warning is deferred: a protocol-change event cancels it (the
 * saved pet re-applies through the existing subscription), and only the
 * settle deadline passing with the terminal still unavailable emits it.
 * Returns a disposer that cancels the pending decision.
 */
export function warnWhenPetCapabilitySettled(options: {
	probePending: boolean;
	isAvailable?: () => boolean;
	onUnavailable: () => void;
	settleMs?: number;
}): () => void {
	if (!options.probePending) {
		options.onUnavailable();
		return () => {};
	}
	const isAvailable = options.isAvailable ?? isPetAvailable;
	let settled = false;
	const finish = () => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		unsubscribe();
	};
	const unsubscribe = onImageProtocolChanged(protocol => {
		if (!protocol) return;
		finish();
	});
	const timer = setTimeout(() => {
		finish();
		if (!isAvailable()) options.onUnavailable();
	}, options.settleMs ?? PET_CAPABILITY_SETTLE_MS);
	timer.unref?.();
	return finish;
}
