import { describe, expect, it, vi } from "vitest";
import {
  createVault,
  getEncryptionSalt,
  getKeyCheck,
  listVisibleVaults,
  deleteVaultOwned,
  updateVaultSettings,
} from "./vault-handlers";
import type {
  InsertVaultFn,
  FindVaultByIdFn,
  DeleteVaultByIdFn,
  ListVisibleVaultsFn,
  UpdateVaultSettingsFn,
  TrimVaultHistoryFn,
} from "./vault-handlers";
import { DEFAULT_HISTORY_LIMITS } from "@courier/shared";
import { NotFoundError, VaultLimitReachedError } from "../lib/errors";

function mockVault(overrides: Partial<ReturnType<typeof mockVaultRow>> = {}) {
  return mockVaultRow(overrides);
}

function mockVaultRow(
  overrides: Partial<{
    id: string;
    name: string;
    ownerUserId: string | null;
    encryptionSalt: string | null;
    keyCheck: string | null;
    historyLimitDocuments: number;
    historyLimitAttachments: number;
    createdAt: Date;
    updatedAt: Date;
  }> = {},
) {
  return {
    id: "test-id",
    name: "Test Vault",
    ownerUserId: null,
    encryptionSalt: "",
    keyCheck: "",
    historyLimitDocuments: DEFAULT_HISTORY_LIMITS.documents,
    historyLimitAttachments: DEFAULT_HISTORY_LIMITS.attachments,
    createdAt: new Date("2026-06-10T00:00:00.000Z"),
    updatedAt: new Date("2026-06-10T00:00:00.000Z"),
    ...overrides,
  };
}

describe("createVault", () => {
  it("inserts a vault and returns id, name, createdAt and the starting limits from DB", async () => {
    const dbCreatedAt = new Date("2026-06-11T12:00:00.000Z");
    const insertFn = vi.fn<InsertVaultFn>().mockResolvedValue({
      createdAt: dbCreatedAt,
      historyLimitDocuments: 200,
      historyLimitAttachments: 10,
    });

    const result = await createVault(
      {
        name: "My Vault",
        encryptionSalt: "esalt",
        keyCheck: "canary-ciphertext",
        ownerUserId: "u-1",
        maxVaults: 1,
      },
      insertFn,
    );

    expect(result).toHaveProperty("id");
    expect(result.name).toBe("My Vault");
    expect(result.createdAt).toBe(dbCreatedAt.toISOString());
    // The vault's retention limits are part of what a create answers: the settings page
    // and the CLI both print/read them without a second request.
    expect(result.historyLimitDocuments).toBe(200);
    expect(result.historyLimitAttachments).toBe(10);
    expect(result).not.toHaveProperty("token");

    expect(insertFn).toHaveBeenCalledTimes(1);
    const data = insertFn.mock.calls[0][0];
    expect(data.name).toBe("My Vault");
    expect(data.encryptionSalt).toBe("esalt");
    expect(data.keyCheck).toBe("canary-ciphertext");
    expect(data.ownerUserId).toBe("u-1");
    expect(data.maxVaults).toBe(1);
    expect(data.id).toBe(result.id);
  });

  it("refuses a vault when the owner's allowance is full", async () => {
    const insertFn = vi.fn<InsertVaultFn>().mockResolvedValue(undefined);

    await expect(
      createVault(
        {
          name: "One too many",
          encryptionSalt: "esalt",
          keyCheck: "canary-ciphertext",
          ownerUserId: "u-1",
          maxVaults: 1,
        },
        insertFn,
      ),
    ).rejects.toThrow(VaultLimitReachedError);
  });

  it("leaves a legacy (owner-less) vault uncounted", async () => {
    const insertFn = vi.fn<InsertVaultFn>().mockResolvedValue({
      createdAt: new Date("2026-06-11T12:00:00.000Z"),
      historyLimitDocuments: 200,
      historyLimitAttachments: 10,
    });

    await createVault(
      {
        name: "Legacy",
        encryptionSalt: "esalt",
        keyCheck: "canary-ciphertext",
        ownerUserId: null,
        maxVaults: 1,
      },
      insertFn,
    );

    expect(insertFn.mock.calls[0][0].maxVaults).toBe(1);
  });
});

describe("getEncryptionSalt", () => {
  it("returns encryptionSalt when vault exists", async () => {
    const findById = vi
      .fn<FindVaultByIdFn>()
      .mockResolvedValue(mockVault({ encryptionSalt: "my-enc-salt" }));

    const result = await getEncryptionSalt("test-id", findById);

    expect(result.encryptionSalt).toBe("my-enc-salt");
    expect(findById).toHaveBeenCalledWith("test-id");
  });

  it("throws NotFoundError when vault does not exist", async () => {
    const findById = vi.fn<FindVaultByIdFn>().mockResolvedValue(undefined);

    await expect(getEncryptionSalt("missing-id", findById)).rejects.toThrow(NotFoundError);
  });

  it("throws NotFoundError when vault has no encryptionSalt", async () => {
    const findById = vi
      .fn<FindVaultByIdFn>()
      .mockResolvedValue(mockVault({ encryptionSalt: null }));

    await expect(getEncryptionSalt("test-id", findById)).rejects.toThrow(NotFoundError);
  });
});

describe("getKeyCheck", () => {
  it("returns keyCheck when vault exists", async () => {
    const findById = vi
      .fn<FindVaultByIdFn>()
      .mockResolvedValue(mockVault({ keyCheck: "my-canary" }));

    const result = await getKeyCheck("test-id", findById);

    expect(result.keyCheck).toBe("my-canary");
    expect(findById).toHaveBeenCalledWith("test-id");
  });

  it("throws NotFoundError when vault does not exist", async () => {
    const findById = vi.fn<FindVaultByIdFn>().mockResolvedValue(undefined);

    await expect(getKeyCheck("missing-id", findById)).rejects.toThrow(NotFoundError);
  });

  it("throws NotFoundError when vault has no keyCheck", async () => {
    const findById = vi.fn<FindVaultByIdFn>().mockResolvedValue(mockVault({ keyCheck: null }));

    await expect(getKeyCheck("test-id", findById)).rejects.toThrow(NotFoundError);
  });
});

describe("listVisibleVaults", () => {
  it("returns the vaults the user may access, with their retention limits", async () => {
    const listFn = vi.fn<ListVisibleVaultsFn>().mockResolvedValue([
      {
        id: "v1",
        name: "Mine",
        createdAt: new Date("2026-06-10T00:00:00Z"),
        historyLimitDocuments: 500,
        historyLimitAttachments: 3,
      },
    ]);

    const result = await listVisibleVaults("u-1", listFn);

    expect(listFn).toHaveBeenCalledWith("u-1");
    expect(result.vaults).toEqual([
      {
        id: "v1",
        name: "Mine",
        createdAt: "2026-06-10T00:00:00.000Z",
        historyLimitDocuments: 500,
        historyLimitAttachments: 3,
      },
    ]);
  });
});

describe("updateVaultSettings / deleteVaultOwned", () => {
  it("renames a vault the user owns, keeping its limits", async () => {
    const findById = vi.fn<FindVaultByIdFn>().mockResolvedValue(mockVault({ ownerUserId: "u-1" }));
    const updateFn = vi.fn<UpdateVaultSettingsFn>().mockResolvedValue({
      id: "v1",
      name: "Renamed",
      historyLimitDocuments: DEFAULT_HISTORY_LIMITS.documents,
      historyLimitAttachments: DEFAULT_HISTORY_LIMITS.attachments,
    });
    const trimFn = vi.fn<TrimVaultHistoryFn>().mockResolvedValue({ rows: 0, blobs: 0 });

    const result = await updateVaultSettings(
      "v1",
      "u-1",
      { name: "Renamed" },
      findById,
      updateFn,
      trimFn,
    );

    expect(result).toEqual({
      id: "v1",
      name: "Renamed",
      historyLimitDocuments: DEFAULT_HISTORY_LIMITS.documents,
      historyLimitAttachments: DEFAULT_HISTORY_LIMITS.attachments,
    });
    expect(updateFn).toHaveBeenCalledWith("v1", { name: "Renamed" });
    // A rename states no limit, so nothing is scanned for trimming.
    expect(trimFn).not.toHaveBeenCalled();
  });

  it("writes a stated limit and trims the vault to what is now in force", async () => {
    const findById = vi.fn<FindVaultByIdFn>().mockResolvedValue(mockVault({ id: "v1" }));
    const updateFn = vi.fn<UpdateVaultSettingsFn>().mockResolvedValue({
      id: "v1",
      name: "Test Vault",
      historyLimitDocuments: 40,
      historyLimitAttachments: 10,
    });
    const trimFn = vi.fn<TrimVaultHistoryFn>().mockResolvedValue({ rows: 12, blobs: 3 });

    await updateVaultSettings(
      "v1",
      "u-1",
      { historyLimitDocuments: 40 },
      findById,
      updateFn,
      trimFn,
    );

    // Only the half the request states is written: writing the other one back from the
    // row read above is what let two PATCHes that touch different halves clobber each
    // other (and a rename race a limit change).
    expect(updateFn).toHaveBeenCalledWith("v1", { historyLimitDocuments: 40 });
    // A stated limit always runs the trim, so a retried PATCH also finishes the job.
    expect(trimFn).toHaveBeenCalledWith("v1", { documents: 40, attachments: 10 });
  });

  it("keeps a nonsense value at the current limit instead of writing it", async () => {
    const findById = vi.fn<FindVaultByIdFn>().mockResolvedValue(mockVault({ id: "v1" }));
    const updateFn = vi.fn<UpdateVaultSettingsFn>().mockResolvedValue({
      id: "v1",
      name: "Test Vault",
      historyLimitDocuments: DEFAULT_HISTORY_LIMITS.documents,
      historyLimitAttachments: DEFAULT_HISTORY_LIMITS.attachments,
    });
    const trimFn = vi.fn<TrimVaultHistoryFn>().mockResolvedValue({ rows: 0, blobs: 0 });

    await updateVaultSettings(
      "v1",
      "u-1",
      { historyLimitAttachments: 0 },
      findById,
      updateFn,
      trimFn,
    );

    expect(updateFn).toHaveBeenCalledWith("v1", {
      historyLimitAttachments: DEFAULT_HISTORY_LIMITS.attachments,
    });
  });

  it("answers a vault owned by someone else as not found", async () => {
    // Not `Unauthorized`: the refusal must not read as "your key is dead", and it must
    // not confirm that someone else's vault id exists.
    const findById = vi.fn<FindVaultByIdFn>().mockResolvedValue(mockVault({ ownerUserId: "u-9" }));
    const updateFn = vi.fn<UpdateVaultSettingsFn>();

    await expect(
      updateVaultSettings("v1", "u-1", { name: "X" }, findById, updateFn, vi.fn()),
    ).rejects.toThrow(NotFoundError);
    expect(updateFn).not.toHaveBeenCalled();
  });

  it("answers not found when the vault disappears between the read and the update", async () => {
    // A delete racing a PATCH: the access-control read found the row, the update did not.
    // It must be the same 404 as a missing vault, not a crash on the missing row.
    const findById = vi.fn<FindVaultByIdFn>().mockResolvedValue(mockVault({ id: "v1" }));
    const updateFn = vi.fn<UpdateVaultSettingsFn>().mockResolvedValue(undefined);
    const trimFn = vi.fn<TrimVaultHistoryFn>();

    await expect(
      updateVaultSettings("v1", "u-1", { historyLimitDocuments: 10 }, findById, updateFn, trimFn),
    ).rejects.toThrow(NotFoundError);
    expect(trimFn).not.toHaveBeenCalled();
  });

  it("deletes a legacy vault from any user", async () => {
    const findById = vi.fn<FindVaultByIdFn>().mockResolvedValue(mockVault({ ownerUserId: null }));
    const deleteById = vi.fn<DeleteVaultByIdFn>();

    await deleteVaultOwned("v1", "u-1", findById, deleteById);

    expect(deleteById).toHaveBeenCalledWith("v1");
  });

  it("throws NotFound when the vault does not exist", async () => {
    const findById = vi.fn<FindVaultByIdFn>().mockResolvedValue(undefined);

    await expect(deleteVaultOwned("missing", "u-1", findById, vi.fn())).rejects.toThrow(
      NotFoundError,
    );
  });
});
