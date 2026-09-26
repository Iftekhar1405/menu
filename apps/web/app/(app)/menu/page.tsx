"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { displayPrice, formatMoney } from "@menu/shared";
import { ApiError, api } from "@/lib/api-client";
import { toPreviewMenu } from "@/lib/preview";
import type { Category, Item } from "@/lib/types";
import { useSession } from "@/components/session";
import { useConfirm } from "@/components/confirm";
import { PreviewButton, PreviewRail } from "@/components/menu-preview";
import { Banner, Button, Empty, Input, cx } from "@/components/ui";
import {
  ItemSheet,
  emptyDraft,
  toDraft,
  type ItemDraft,
} from "@/components/menu-builder/item-sheet";

export default function MenuPage() {
  const { current } = useSession();
  const confirm = useConfirm();
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<ItemDraft | null>(null);
  const [draftIsNew, setDraftIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newCategory, setNewCategory] = useState("");

  const load = useCallback(async () => {
    if (!current) return;
    const data = await api.get<Category[]>(`/businesses/${current.id}/menu`);
    setCategories(data);
    setLoading(false);
  }, [current]);

  useEffect(() => {
    void load();
  }, [load]);

  const previewMenu = useMemo(
    () => (current ? toPreviewMenu(current, categories) : null),
    [current, categories],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (!current) return null;

  /**
   * Runs a write, and says so when it fails.
   *
   * A rejected promise in an event handler is invisible: React logs it and
   * the screen keeps whatever state it had. What the owner sees is a button
   * that did nothing — no message, no spinner, the text still sitting in the
   * field — and the only reasonable response is to press it again. On the
   * wifi in a busy restaurant that is a regular occurrence, not an edge case.
   *
   * Reloading afterwards is what puts an optimistic change back when the
   * server refused it.
   */
  async function write(what: string, run: () => Promise<void>) {
    setError(null);
    try {
      await run();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not ${what}. Try again.`);
      await load().catch(() => undefined);
    }
  }

  async function addCategory(e: React.FormEvent) {
    e.preventDefault();
    if (!newCategory.trim() || !current) return;
    await write("add that section", async () => {
      await api.post(`/businesses/${current.id}/categories`, {
        name: newCategory.trim(),
        isVisible: true,
      });
      // Cleared only once it is saved, so a failed write leaves the name in
      // the field to try again with rather than discarding what was typed.
      setNewCategory("");
      await load();
    });
  }

  async function saveDraft() {
    if (!draft || !current) return;
    setSaving(true);
    setSheetError(null);

    const body = {
      name: draft.name.trim(),
      categoryId: draft.categoryId,
      price: draft.variants.length > 0 ? null : draft.price ? Number(draft.price) : null,
      description: draft.description.trim() || null,
      isAvailable: draft.isAvailable,
      dietTag: draft.dietTag,
      spiceLevel: draft.spiceLevel,
      prepTimeMins: draft.prepTimeMins ? Number(draft.prepTimeMins) : null,
      ingredients: draft.ingredients.trim() || null,
      allergens: draft.allergens
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean),
      nutrition: cleanNutrition(draft.nutrition),
      taxRate: draft.taxRate ? Number(draft.taxRate) : null,
      variants: draft.variants
        .filter((v) => v.name.trim() && v.price)
        .map((v) => ({ name: v.name.trim(), price: Number(v.price) })),
      photos: draft.photos.map((p) => ({ storagePath: p.storagePath, alt: p.alt })),
    };

    try {
      if (draftIsNew) {
        await api.post(`/businesses/${current.id}/items`, body);
      } else {
        await api.put(`/businesses/${current.id}/items/${draft.id}`, body);
      }
      setDraft(null);
      await load();
    } catch (err) {
      setSheetError(
        err instanceof ApiError ? err.message : "Could not save this dish.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function deleteItem() {
    if (!draft || !current || draftIsNew) return;
    const ok = await confirm({
      title: `Delete "${draft.name}"?`,
      body: "It comes off your menu immediately. Past orders and bills keep their own copy, so nothing already sold is affected.",
      confirmLabel: "Delete dish",
    });
    if (!ok) return;
    await write("delete that dish", async () => {
      await api.del(`/businesses/${current.id}/items/${draft.id}`);
      setDraft(null);
      await load();
    });
  }

  async function reorder(categoryId: string, event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || !current) return;

    const category = categories.find((c) => c.id === categoryId);
    if (!category) return;

    const oldIndex = category.items.findIndex((i) => i.id === active.id);
    const newIndex = category.items.findIndex((i) => i.id === over.id);
    const items = arrayMove(category.items, oldIndex, newIndex);

    // Optimistic: the list settles instantly, the request follows.
    setCategories((prev) =>
      prev.map((c) => (c.id === categoryId ? { ...c, items } : c)),
    );

    try {
      await api.patch(`/businesses/${current.id}/items/reorder`, {
        categoryId,
        ids: items.map((i) => i.id),
      });
    } catch {
      setError("That reorder didn't save. Reloading.");
      await load();
    }
  }

  async function toggleCategoryVisible(category: Category) {
    if (!current) return;
    setCategories((prev) =>
      prev.map((c) => (c.id === category.id ? { ...c, isVisible: !c.isVisible } : c)),
    );
    await write(
      category.isVisible ? "hide that section" : "show that section",
      async () => {
        await api.patch(`/businesses/${current.id}/categories/${category.id}`, {
          isVisible: !category.isVisible,
        });
      },
    );
  }

  async function deleteCategory(category: Category) {
    if (!current) return;
    const ok = await confirm({
      title: `Delete "${category.name}"?`,
      body: "The section disappears from your menu straight away.",
      confirmLabel: "Delete section",
    });
    if (!ok) return;
    await write("delete that section", async () => {
      await api.del(`/businesses/${current.id}/categories/${category.id}`);
      await load();
    });
  }

  return (
    <div className="xl:grid xl:min-h-[100dvh] xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="mx-auto w-full max-w-2xl px-5 py-8 sm:px-6 sm:py-10 lg:px-10 lg:py-12">
        <header className="mb-6 flex items-start justify-between gap-4 sm:mb-8">
          <div className="min-w-0">
            <h1 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[30px]">
              Menu
            </h1>
            <p className="mt-1 text-[14.5px] text-muted">
              Changes go live as soon as you save.
            </p>
          </div>
          {/* Below `xl` there is no room for the rail beside the builder, so
              the preview moves behind a button. */}
          <div className="shrink-0 xl:hidden">
            <PreviewButton menu={previewMenu} />
          </div>
        </header>

        {error && (
          <div className="mb-6">
            <Banner>{error}</Banner>
          </div>
        )}

        {loading ? (
          <p className="text-[14px] text-faint">Loading…</p>
        ) : categories.length === 0 ? (
          <Empty
            title="Start with a section"
            body="Sections group your dishes — Starters, Coffee, Combos. Most menus need three or four."
            action={
              <form onSubmit={addCategory} className="flex w-full max-w-sm gap-2">
                <Input
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  placeholder="Coffee"
                  autoFocus
                />
                <Button type="submit" variant="primary">
                  Add
                </Button>
              </form>
            }
          />
        ) : (
          <div className="space-y-8">
            {categories.map((category) => (
              <section key={category.id}>
                <div className="mb-2.5 flex items-center justify-between gap-3">
                  <h2
                    className={cx(
                      "font-display text-[17px] font-semibold",
                      !category.isVisible && "text-faint line-through",
                    )}
                  >
                    {category.name}
                  </h2>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void toggleCategoryVisible(category)}
                    >
                      {category.isVisible ? "Hide" : "Show"}
                    </Button>
                    {category.items.length === 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void deleteCategory(category)}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                </div>

                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={(e) => void reorder(category.id, e)}
                >
                  <SortableContext
                    items={category.items.map((i) => i.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <ul className="overflow-hidden rounded-2xl border border-line bg-surface">
                      {category.items.map((item) => (
                        <SortableItem
                          key={item.id}
                          item={item}
                          currency={current.currency}
                          onOpen={() => {
                            setDraft(toDraft(item));
                            setDraftIsNew(false);
                            setSheetError(null);
                          }}
                        />
                      ))}
                      {category.items.length === 0 && (
                        <li className="px-4 py-6 text-center text-[13.5px] text-faint">
                          Nothing in this section yet.
                        </li>
                      )}
                    </ul>
                  </SortableContext>
                </DndContext>

                <Button
                  size="sm"
                  className="mt-2.5"
                  onClick={() => {
                    setDraft(emptyDraft(category.id));
                    setDraftIsNew(true);
                    setSheetError(null);
                  }}
                >
                  Add a dish to {category.name}
                </Button>
              </section>
            ))}

            <form onSubmit={addCategory} className="flex max-w-sm gap-2 pt-2">
              <Input
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                placeholder="New section"
              />
              <Button type="submit">Add section</Button>
            </form>
          </div>
        )}
      </div>

      {/* The preview is the point of the page: an owner is designing something
          that only ever gets read on a phone. */}
      <PreviewRail
        menu={previewMenu}
        scale={0.78}
        label="What diners see"
        className="hidden border-l border-line bg-surface xl:block"
      />

      {draft && (
        <ItemSheet
          draft={draft}
          categories={categories}
          businessId={current.id}
          isNew={draftIsNew}
          saving={saving}
          error={sheetError}
          onChange={setDraft}
          onSave={() => void saveDraft()}
          onDelete={draftIsNew ? undefined : () => void deleteItem()}
          onClose={() => setDraft(null)}
        />
      )}
    </div>
  );
}

function SortableItem({
  item,
  currency,
  onOpen,
}: {
  item: Item;
  currency: string;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });

  const price = displayPrice({
    ...item,
    variants: item.variants.map((v) => ({ id: v.id, name: v.name, price: v.price })),
    photos: [],
    allergens: [],
    nutrition: null,
  } as never);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx(
        "flex items-center gap-3 border-t border-line px-3 py-2.5 first:border-t-0",
        isDragging && "relative z-10 bg-raised shadow-lift",
      )}
    >
      <button
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${item.name}`}
        className="spring flex h-9 w-6 shrink-0 cursor-grab items-center justify-center text-faint hover:text-muted active:cursor-grabbing"
      >
        <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
          <circle cx="2" cy="3" r="1.4" /><circle cx="8" cy="3" r="1.4" />
          <circle cx="2" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" />
          <circle cx="2" cy="13" r="1.4" /><circle cx="8" cy="13" r="1.4" />
        </svg>
      </button>

      {item.photos[0] ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`${item.photos[0].storagePath.startsWith("http") ? "" : ""}${item.photos[0].storagePath}`}
          alt=""
          className="hidden"
        />
      ) : null}

      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="min-w-0 flex-1">
          <span
            className={cx(
              "block truncate text-[14.5px] font-medium",
              !item.isAvailable && "text-faint",
            )}
          >
            {item.name}
          </span>
          {!item.isAvailable && (
            <span className="text-[12px] text-faint">Not available today</span>
          )}
        </span>
        <span className="tnum shrink-0 text-[14px] text-muted">
          {price
            ? `${price.from ? "from " : ""}${formatMoney(price.amount, currency)}`
            : "—"}
        </span>
      </button>
    </li>
  );
}

function cleanNutrition(raw: Record<string, string>) {
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!v.trim()) continue;
    out[k] = k === "servingSize" ? v.trim() : Number(v);
  }
  return Object.keys(out).length > 0 ? out : null;
}
