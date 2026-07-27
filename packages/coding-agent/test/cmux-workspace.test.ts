import { describe, expect, it, type Mock, vi } from "bun:test";
import {
	buildCmuxNotifyCommand,
	buildCmuxWorkspaceRenameCommand,
	type CmuxWorkspaceOwnership,
	formatCmuxWorkspaceTitle,
	parseCmuxWorkspaceOwnership,
	sanitizeCmuxNotificationText,
	sanitizeCmuxWorkspaceTitle,
	sendCmuxNotification,
	shouldRenameCmuxWorkspace,
	syncCmuxWorkspaceTitle,
} from "../src/utils/cmux-workspace";

function cmuxEnv(workspaceId = "workspace-123", extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return { CMUX_WORKSPACE_ID: workspaceId, ...extra } as NodeJS.ProcessEnv;
}

const LIST_JSON = JSON.stringify({
	workspaces: [
		{ id: "AAAA-1111", ref: "workspace:1", title: "Other", has_custom_title: true },
		{ id: "DF98857C", ref: "workspace:8", title: "GJC: gajae-code", has_custom_title: true },
		{ id: "CCCC-9999", ref: "workspace:9", title: "~/dev/x", has_custom_title: false },
	],
});
function pendingExitProcess(): {
	exited: Promise<number>;
	resolve: (exitCode: number) => void;
	reject: (error: Error) => void;
	kill: Mock<() => void>;
	unref: Mock<() => void>;
} {
	const deferred = Promise.withResolvers<number>();
	return {
		exited: deferred.promise,
		resolve: deferred.resolve,
		reject: deferred.reject,
		kill: vi.fn(() => {}),
		unref: vi.fn(() => {}),
	};
}

describe("cmux notifications", () => {
	it("builds exact argv with surface priority", () => {
		expect(
			buildCmuxNotifyCommand(
				{ title: "Done", subtitle: "Story G001", body: "Finished" },
				cmuxEnv("workspace-123", { CMUX_SURFACE_ID: "surface-456" }),
			),
		).toEqual({
			command: "cmux",
			args: [
				"notify",
				"--surface",
				"surface-456",
				"--title",
				"Done",
				"--subtitle",
				"Story G001",
				"--body",
				"Finished",
			],
		});
	});

	it("falls back to workspace argv when no surface id is present", () => {
		expect(buildCmuxNotifyCommand({ title: "Done" }, cmuxEnv("workspace-123"))).toEqual({
			command: "cmux",
			args: ["notify", "--workspace", "workspace-123", "--title", "Done"],
		});
	});

	it("returns null with no cmux target", () => {
		expect(buildCmuxNotifyCommand({ title: "Done" }, {} as NodeJS.ProcessEnv)).toBeNull();
	});

	it("send skips before lookup with no cmux target", async () => {
		let lookedUp = false;
		let spawned = false;
		await sendCmuxNotification(
			{ title: "Done" },
			{
				env: {} as NodeJS.ProcessEnv,
				which: () => {
					lookedUp = true;
					return "/opt/bin/cmux";
				},
				spawn: () => {
					spawned = true;
					return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
				},
			},
		);
		expect(lookedUp).toBe(false);
		expect(spawned).toBe(false);
	});

	it("sanitizes notification metadata", () => {
		expect(sanitizeCmuxNotificationText("  Done\u0001\u001b\n\t now  ")).toBe("Done now");
		expect(sanitizeCmuxNotificationText("abcdef", 4)).toBe("abcd");
		expect(sanitizeCmuxNotificationText("\n\t")).toBeUndefined();
	});

	it("skips sanitized empty title", () => {
		expect(buildCmuxNotifyCommand({ title: "\u0001\n\t" }, cmuxEnv("workspace-123"))).toBeNull();
	});

	it("skips when cmux lookup fails or is unavailable", async () => {
		let spawned = false;
		await sendCmuxNotification(
			{ title: "Done" },
			{
				env: cmuxEnv("workspace-123"),
				which: () => null,
				spawn: () => {
					spawned = true;
					return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
				},
			},
		);
		expect(spawned).toBe(false);

		await sendCmuxNotification(
			{ title: "Done" },
			{
				env: cmuxEnv("workspace-123"),
				which: () => {
					throw new Error("lookup failed");
				},
				spawn: () => {
					spawned = true;
					return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
				},
			},
		);
		expect(spawned).toBe(false);
	});

	it("spawns the resolved command with CMUX_QUIET and ignored stdio", async () => {
		const proc = pendingExitProcess();
		const calls: string[][] = [];
		const envs: NodeJS.ProcessEnv[] = [];

		await sendCmuxNotification(
			{ title: "Done", subtitle: "Ready" },
			{
				env: cmuxEnv("workspace-123", { CMUX_SURFACE_ID: "surface-456" }),
				which: command => (command === "cmux" ? "/opt/bin/cmux" : null),
				spawn: (command, options) => {
					calls.push(command);
					envs.push(options.env);
					expect(options.stdin).toBe("ignore");
					expect(options.stdout).toBe("ignore");
					expect(options.stderr).toBe("ignore");
					return proc;
				},
			},
		);

		expect(calls).toEqual([
			["/opt/bin/cmux", "notify", "--surface", "surface-456", "--title", "Done", "--subtitle", "Ready"],
		]);
		expect(envs[0]?.CMUX_QUIET).toBe("1");
		expect(envs[0]?.CMUX_SURFACE_ID).toBe("surface-456");
		expect(proc.unref).toHaveBeenCalledTimes(1);
		expect(proc.kill).not.toHaveBeenCalled();
		proc.resolve(0);
		await Promise.resolve();
	});

	it("kills the notification process on timeout", async () => {
		vi.useFakeTimers();
		try {
			const proc = pendingExitProcess();
			await sendCmuxNotification(
				{ title: "Done" },
				{
					env: cmuxEnv("workspace-123"),
					which: () => "/opt/bin/cmux",
					spawn: () => proc,
				},
			);

			vi.advanceTimersByTime(1499);
			expect(proc.kill).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(proc.kill).toHaveBeenCalledTimes(1);
			proc.resolve(0);
			await Promise.resolve();
		} finally {
			vi.useRealTimers();
		}
	});

	it("skips cleanly when spawn throws", async () => {
		await expect(
			sendCmuxNotification(
				{ title: "Done" },
				{
					env: cmuxEnv("workspace-123"),
					which: () => "/opt/bin/cmux",
					spawn: () => {
						throw new Error("spawn failed");
					},
				},
			),
		).resolves.toBeUndefined();
	});

	it("handles rejected and non-zero notification exits", async () => {
		const rejected = pendingExitProcess();
		await sendCmuxNotification(
			{ title: "Done" },
			{
				env: cmuxEnv("workspace-123"),
				which: () => "/opt/bin/cmux",
				spawn: () => rejected,
			},
		);
		rejected.reject(new Error("exit failed"));
		await Promise.resolve();

		const nonZero = pendingExitProcess();
		await sendCmuxNotification(
			{ title: "Done" },
			{
				env: cmuxEnv("workspace-123"),
				which: () => "/opt/bin/cmux",
				spawn: () => nonZero,
			},
		);
		nonZero.resolve(2);
		await Promise.resolve();

		expect(rejected.kill).not.toHaveBeenCalled();
		expect(nonZero.kill).not.toHaveBeenCalled();
	});
});
describe("cmux workspace title sync", () => {
	it("builds an explicit workspace rename command with the GJC prefix", () => {
		expect(buildCmuxWorkspaceRenameCommand("Investigate Resolver", cmuxEnv())).toEqual({
			command: "cmux",
			args: ["workspace", "rename", "workspace-123", "--title", "GJC: Investigate Resolver"],
		});
	});

	it("skips when the current terminal is not a cmux workspace", () => {
		expect(buildCmuxWorkspaceRenameCommand("Investigate Resolver", {} as NodeJS.ProcessEnv)).toBeNull();
	});

	it("sanitizes control characters and whitespace", () => {
		expect(sanitizeCmuxWorkspaceTitle("  Fix\u0001\u001b  cmux\n\tworkspace  ")).toBe("Fix cmux workspace");
	});

	it("prefixes cmux workspace titles once", () => {
		expect(formatCmuxWorkspaceTitle("Investigate Resolver")).toBe("GJC: Investigate Resolver");
		expect(formatCmuxWorkspaceTitle("GJC: Investigate Resolver")).toBe("GJC: Investigate Resolver");
	});

	describe("parseCmuxWorkspaceOwnership", () => {
		it("matches by UUID id case-insensitively", () => {
			expect(parseCmuxWorkspaceOwnership(LIST_JSON, "df98857c")).toEqual({
				hasCustomTitle: true,
				title: "GJC: gajae-code",
			});
		});

		it("matches by workspace ref", () => {
			expect(parseCmuxWorkspaceOwnership(LIST_JSON, "workspace:9")).toEqual({
				hasCustomTitle: false,
				title: "~/dev/x",
			});
		});

		it("returns null when the workspace is not present", () => {
			expect(parseCmuxWorkspaceOwnership(LIST_JSON, "missing")).toBeNull();
		});

		it("returns null on unparseable output", () => {
			expect(parseCmuxWorkspaceOwnership("not json", "df98857c")).toBeNull();
		});
	});

	describe("shouldRenameCmuxWorkspace", () => {
		const owned = (over: Partial<CmuxWorkspaceOwnership>): CmuxWorkspaceOwnership => ({
			hasCustomTitle: true,
			title: "current",
			...over,
		});

		it("skips when ownership is unknown (read failed)", () => {
			expect(shouldRenameCmuxWorkspace(null, "GJC: Desired")).toBe(false);
		});

		it("skips when the title already matches", () => {
			expect(shouldRenameCmuxWorkspace(owned({ title: "GJC: Desired" }), "GJC: Desired")).toBe(false);
		});

		it("renames when the workspace still has the default title", () => {
			expect(shouldRenameCmuxWorkspace(owned({ hasCustomTitle: false }), "GJC: Desired")).toBe(true);
		});

		it("skips a user- or peer-owned custom title", () => {
			expect(shouldRenameCmuxWorkspace(owned({ title: "My Pinned Name" }), "GJC: Desired")).toBe(false);
			expect(shouldRenameCmuxWorkspace(owned({ title: "GJC: Session A" }), "GJC: Session B")).toBe(false);
		});
	});

	it("does not spawn outside a tty", async () => {
		let spawned = false;
		await syncCmuxWorkspaceTitle("Investigate Resolver", {
			env: cmuxEnv(),
			isTty: false,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle: false, title: "default" }),
			spawn: () => {
				spawned = true;
				return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
			},
		});
		expect(spawned).toBe(false);
	});

	it("does not spawn when GJC_NO_CMUX_RENAME is set", async () => {
		let spawned = false;
		await syncCmuxWorkspaceTitle("Investigate Resolver", {
			env: cmuxEnv("ws-optout", { GJC_NO_CMUX_RENAME: "1" }),
			isTty: true,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle: false, title: "default" }),
			spawn: () => {
				spawned = true;
				return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
			},
		});
		expect(spawned).toBe(false);
	});

	it("renames a default-titled workspace inside a tty cmux workspace", async () => {
		const unref = vi.fn(() => {});
		const kill = vi.fn(() => {});
		const calls: string[][] = [];

		await syncCmuxWorkspaceTitle("Investigate Resolver", {
			env: cmuxEnv("ws-default"),
			isTty: true,
			which: command => (command === "cmux" ? "/usr/local/bin/cmux" : null),
			readOwnership: async () => ({ hasCustomTitle: false, title: "~/dev/x" }),
			spawn: command => {
				calls.push(command);
				return { exited: Promise.resolve(0), kill, unref };
			},
		});

		expect(calls).toEqual([
			["/usr/local/bin/cmux", "workspace", "rename", "ws-default", "--title", "GJC: Investigate Resolver"],
		]);
		expect(unref).toHaveBeenCalledTimes(1);
		expect(kill).not.toHaveBeenCalled();
	});

	it("does not clobber a user-pinned workspace title", async () => {
		let spawned = false;
		await syncCmuxWorkspaceTitle("Investigate Resolver", {
			env: cmuxEnv("ws-userpinned"),
			isTty: true,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle: true, title: "My Pinned Name" }),
			spawn: () => {
				spawned = true;
				return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
			},
		});
		expect(spawned).toBe(false);
	});

	it("skips renaming when ownership cannot be read", async () => {
		let spawned = false;
		await syncCmuxWorkspaceTitle("Investigate Resolver", {
			env: cmuxEnv("ws-unreadable"),
			isTty: true,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => null,
			spawn: () => {
				spawned = true;
				return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
			},
		});
		expect(spawned).toBe(false);
	});

	it("does not thrash a workspace shared by multiple sessions", async () => {
		// Two sessions share one CMUX_WORKSPACE_ID. Session A names the still-default
		// workspace; session B then sees a custom title and must not overwrite it.
		const calls: string[][] = [];
		const spawn = (command: string[]) => {
			calls.push(command);
			return { exited: Promise.resolve(0), kill: () => {}, unref: () => {} };
		};
		await syncCmuxWorkspaceTitle("Session A task", {
			env: cmuxEnv("ws-shared"),
			isTty: true,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle: false, title: "~/dev/x" }),
			spawn,
		});
		await syncCmuxWorkspaceTitle("Session B task", {
			env: cmuxEnv("ws-shared"),
			isTty: true,
			which: () => "/usr/local/bin/cmux",
			readOwnership: async () => ({ hasCustomTitle: true, title: "GJC: Session A task" }),
			spawn,
		});
		expect(calls).toEqual([
			["/usr/local/bin/cmux", "workspace", "rename", "ws-shared", "--title", "GJC: Session A task"],
		]);
	});
});
