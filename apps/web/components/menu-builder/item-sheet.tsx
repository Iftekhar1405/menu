"use client";

import { useEffect, useState } from "react";
import { DIET_TAGS, DIET_TAG_LABEL, SPICE_LEVEL_LABEL } from "@menu/shared";
import type { Category, Item } from "@/lib/types";
import { Button, Field, Input, Select, Textarea, cx } from "../ui";
import { PhotoUploader } from "./photo-uploader";

export interface ItemDraft {
  id: string;
  categoryId: string;
  name: string;
  price: string;
  description: string;
  isAvailable: boolean;
  dietTag: Item["dietTag"];
  spiceLevel: number | null;
  prepTimeMins: string;
  ingredients: string;
  allergens: string;
  nutrition: Record<string, string>;
  variants: { id: string; name: string; price: string }[];
  photos: Item["photos"];
}

export function emptyDraft(categoryId: string): ItemDraft {
  return {
    id: crypto.randomUUID(),
    categoryId,
    name: "",
    price: "",
    description: "",
    isAvailable: true,
    dietTag: null,
    spiceLevel: null,
    prepTimeMins: "",
    ingredients: "",
    allergens: "",
    nutrition: {},
    variants: [],
    photos: [],
  };
}

export function toDraft(item: Item): ItemDraft {
  return {
    id: item.id,
    categoryId: item.categoryId,
    name: item.name,
    price: item.price ?? "",
    description: item.description ?? "",
    isAvailable: item.isAvailable,
    dietTag: item.dietTag,
    spiceLevel: item.spiceLevel,
    prepTimeMins: item.prepTimeMins?.toString() ?? "",
    ingredients: item.ingredients ?? "",
    allergens: item.allergens.join(", "),
    nutrition: Object.fromEntries(
      Object.entries(item.nutrition ?? {}).map(([k, v]) => [k, String(v)]),
    ),
    variants: item.variants.map((v) => ({ id: v.id, name: v.name, price: v.price })),
    photos: item.photos,
  };
}

const NUTRITION_FIELDS = [
  ["calories", "Calories"],
  ["proteinG", "Protein (g)"],
  ["carbsG", "Carbs (g)"],
  ["fatG", "Fat (g)"],
  ["fibreG", "Fibre (g)"],
  ["sugarG", "Sugar (g)"],
  ["sodiumMg", "Sodium (mg)"],
  ["servingSize", "Serving size"],
] as const;

/**
 * The sheet shows three things: name, price, photos.
 *
 * Everything else is behind one disclosure. An owner entering thirty dishes
 * on a Tuesday afternoon should never scroll past a sodium field to get to
 * the next dish — but the restaurant that does want allergens and nutrition
 * on the menu can have all of it.
 */
export function ItemSheet({
  draft,
  categories,
  businessId,
  isNew,
  saving,
  error,
  onChange,
  onSave,
  onDelete,
  onClose,
}: {
  draft: ItemDraft;
  categories: Category[];
  businessId: string;
  isNew: boolean;
  saving: boolean;
  error: string | null;
  onChange: (d: ItemDraft) => void;
  onSave: () => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const set = <K extends keyof ItemDraft>(key: K, value: ItemDraft[K]) =>
    onChange({ ...draft, [key]: value });

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);

  const pricedByVariant = draft.variants.length > 0;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-[rgba(17,17,19,0.28)]"
      />

      <div
        role="dialog"
        aria-label={isNew ? "Add a dish" : `Edit ${draft.name || "dish"}`}
        className="relative flex h-full w-full max-w-[460px] flex-col bg-surface shadow-lift"
      >
        <header className="chrome-blur sticky top-0 z-10 flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="font-display text-[16px] font-semibold">
            {isNew ? "Add a dish" : "Edit dish"}
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </header>

        <div className="scroll-quiet flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {error && (
            <p className="rounded-xl border border-[#F0D5D3] bg-[#FDF3F2] px-3.5 py-3 text-[13.5px] text-[#8C1D18]">
              {error}
            </p>
          )}

          <Field label="Name">
            <Input
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Masala dosa"
              autoFocus
            />
          </Field>

          {/* Price and sizes are one control. The moment a size exists the
              single price disappears, so the two can never disagree. */}
          {!pricedByVariant ? (
            <Field label="Price">
              <div className="flex gap-2">
                <Input
                  value={draft.price}
                  onChange={(e) => set("price", e.target.value.replace(/[^\d.]/g, ""))}
                  inputMode="decimal"
                  placeholder="140"
                  className="tnum flex-1"
                />
                <Button
                  type="button"
                  onClick={() =>
                    set("variants", [
                      { id: crypto.randomUUID(), name: "Small", price: draft.price || "" },
                      { id: crypto.randomUUID(), name: "Large", price: "" },
                    ])
                  }
                >
                  Add sizes
                </Button>
              </div>
            </Field>
          ) : (
            <fieldset>
              <div className="mb-1.5 flex items-baseline justify-between">
                <legend className="text-[13px] font-medium text-ink">Sizes</legend>
                <button
                  type="button"
                  onClick={() => set("variants", [])}
                  className="text-[12.5px] text-muted hover:text-ink"
                >
                  Use one price instead
                </button>
              </div>
              <div className="space-y-2">
                {draft.variants.map((v, i) => (
                  <div key={v.id} className="flex gap-2">
                    <Input
                      value={v.name}
                      onChange={(e) => {
                        const next = [...draft.variants];
                        next[i] = { ...v, name: e.target.value };
                        set("variants", next);
                      }}
                      placeholder="Small"
                      className="flex-1"
                    />
                    <Input
                      value={v.price}
                      onChange={(e) => {
                        const next = [...draft.variants];
                        next[i] = { ...v, price: e.target.value.replace(/[^\d.]/g, "") };
                        set("variants", next);
                      }}
                      inputMode="decimal"
                      placeholder="140"
                      className="tnum w-28"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        set(
                          "variants",
                          draft.variants.filter((x) => x.id !== v.id),
                        )
                      }
                      aria-label={`Remove ${v.name || "size"}`}
                    >
                      ×
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  size="sm"
                  onClick={() =>
                    set("variants", [
                      ...draft.variants,
                      { id: crypto.randomUUID(), name: "", price: "" },
                    ])
                  }
                >
                  Add another size
                </Button>
              </div>
            </fieldset>
          )}

          <PhotoUploader
            businessId={businessId}
            itemId={draft.id}
            photos={draft.photos}
            onChange={(photos) => set("photos", photos)}
          />

          <label className="flex items-center gap-2.5">
            <input
              type="checkbox"
              checked={draft.isAvailable}
              onChange={(e) => set("isAvailable", e.target.checked)}
              className="h-[18px] w-[18px] accent-[var(--accent)]"
            />
            <span className="text-[14px] text-ink">Available today</span>
          </label>

          {categories.length > 1 && (
            <Field label="Section">
              <Select
                value={draft.categoryId}
                onChange={(e) => set("categoryId", e.target.value)}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {/* ── The disclosure ── */}
          <div className="border-t border-line pt-4">
            <button
              type="button"
              onClick={() => setAdvanced((a) => !a)}
              aria-expanded={advanced}
              className="flex w-full items-center justify-between text-[14px] font-medium text-ink"
            >
              Advanced details
              <span className={cx("spring text-faint", advanced && "rotate-180")}>⌄</span>
            </button>
            <p className="mt-1 text-[12.5px] text-faint">
              Description, diet, allergens and nutrition. All optional.
            </p>

            {advanced && (
              <div className="mt-4 space-y-5">
                <Field label="Description" optional>
                  <Textarea
                    rows={3}
                    value={draft.description}
                    onChange={(e) => set("description", e.target.value)}
                    placeholder="Potato masala, coconut chutney, sambar."
                  />
                </Field>

                <fieldset>
                  <legend className="mb-1.5 text-[13px] font-medium text-ink">Diet</legend>
                  <div className="flex flex-wrap gap-2">
                    {DIET_TAGS.map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => set("dietTag", draft.dietTag === t ? null : t)}
                        aria-pressed={draft.dietTag === t}
                        className={cx(
                          "spring h-9 rounded-xl border px-3 text-[13px]",
                          draft.dietTag === t
                            ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]"
                            : "border-line text-muted hover:border-[#d6d9de]",
                        )}
                      >
                        {DIET_TAG_LABEL[t]}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <fieldset>
                  <legend className="mb-1.5 text-[13px] font-medium text-ink">Spice</legend>
                  <div className="flex flex-wrap gap-2">
                    {[0, 1, 2, 3].map((lvl) => (
                      <button
                        key={lvl}
                        type="button"
                        onClick={() =>
                          set("spiceLevel", draft.spiceLevel === lvl ? null : lvl)
                        }
                        aria-pressed={draft.spiceLevel === lvl}
                        className={cx(
                          "spring h-9 rounded-xl border px-3 text-[13px]",
                          draft.spiceLevel === lvl
                            ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]"
                            : "border-line text-muted hover:border-[#d6d9de]",
                        )}
                      >
                        {SPICE_LEVEL_LABEL[lvl]}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <Field label="Ingredients" optional>
                  <Textarea
                    rows={2}
                    value={draft.ingredients}
                    onChange={(e) => set("ingredients", e.target.value)}
                    placeholder="Rice, urad dal, potato, mustard, curry leaf"
                  />
                </Field>

                <Field
                  label="Allergens"
                  optional
                  hint="Separate with commas. These are shown to diners."
                >
                  <Input
                    value={draft.allergens}
                    onChange={(e) => set("allergens", e.target.value)}
                    placeholder="milk, mustard, gluten"
                  />
                </Field>

                <Field label="Prepared in (minutes)" optional>
                  <Input
                    value={draft.prepTimeMins}
                    onChange={(e) =>
                      set("prepTimeMins", e.target.value.replace(/[^\d]/g, ""))
                    }
                    inputMode="numeric"
                    placeholder="12"
                    className="tnum w-28"
                  />
                </Field>

                <fieldset>
                  <legend className="mb-1.5 text-[13px] font-medium text-ink">
                    Nutrition
                  </legend>
                  <div className="grid grid-cols-2 gap-2">
                    {NUTRITION_FIELDS.map(([key, label]) => (
                      <label key={key} className="block">
                        <span className="mb-1 block text-[12px] text-faint">{label}</span>
                        <Input
                          value={draft.nutrition[key] ?? ""}
                          onChange={(e) =>
                            set("nutrition", {
                              ...draft.nutrition,
                              [key]: e.target.value,
                            })
                          }
                          inputMode={key === "servingSize" ? "text" : "decimal"}
                          className="tnum h-10"
                        />
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
            )}
          </div>
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-line px-5 py-3.5">
          {onDelete ? (
            <Button variant="danger" size="sm" onClick={onDelete}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <Button variant="primary" onClick={onSave} loading={saving}>
            {isNew ? "Add dish" : "Save changes"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
