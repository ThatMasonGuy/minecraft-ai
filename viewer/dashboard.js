const elements = {
  activityDot: document.querySelector("#activity-dot"),
  activityPhase: document.querySelector("#activity-phase"),
  goalTitle: document.querySelector("#goal-title"),
  goalRationale: document.querySelector("#goal-rationale"),
  activityLabel: document.querySelector("#activity-label"),
  activityDetail: document.querySelector("#activity-detail"),
  workProgress: document.querySelector("#work-progress"),
  workLabel: document.querySelector("#work-label"),
  workCount: document.querySelector("#work-count"),
  workFill: document.querySelector("#work-fill"),
  playerName: document.querySelector("#player-name"),
  position: document.querySelector("#position"),
  dimension: document.querySelector("#dimension"),
  worldState: document.querySelector("#world-state"),
  inventoryButton: document.querySelector("#inventory-button"),
  inventoryCount: document.querySelector("#inventory-count"),
  inventoryDialog: document.querySelector("#inventory-dialog"),
  inventoryClose: document.querySelector("#inventory-close"),
  inventoryMain: document.querySelector("#inventory-main"),
  inventoryHotbar: document.querySelector("#inventory-hotbar"),
  inventoryEquipment: document.querySelector("#inventory-equipment"),
  inventoryTotal: document.querySelector("#inventory-total"),
  inventorySlots: document.querySelector("#inventory-slots"),
  health: document.querySelector("#health"),
  food: document.querySelector("#food"),
  hotbar: document.querySelector("#hotbar"),
  oxygen: document.querySelector("#oxygen"),
  experienceFill: document.querySelector("#experience-fill"),
  experienceLevel: document.querySelector("#experience-level"),
  playerHud: document.querySelector(".player-hud"),
  connectionWarning: document.querySelector("#connection-warning")
};

let lastSuccess = 0;
const minecraftVersion =
  window.minecraftAiViewerConfig?.minecraftVersion || "1.21.4";

function render(snapshot) {
  lastSuccess = Date.now();
  elements.connectionWarning.hidden = true;

  const activity = snapshot.activity;
  elements.activityDot.dataset.phase = activity.phase;
  elements.activityPhase.textContent = activityPhase(activity.phase);
  elements.activityLabel.textContent = activity.label;
  elements.activityDetail.textContent = activity.detail || "";
  elements.activityDetail.hidden = !activity.detail;

  if (snapshot.primaryGoal) {
    elements.goalTitle.textContent = snapshot.primaryGoal.title;
    elements.goalRationale.textContent = snapshot.primaryGoal.rationale;
  } else {
    elements.goalTitle.textContent = "No active goal";
    elements.goalRationale.textContent =
      activity.phase === "connecting"
        ? "Waiting for the Minecraft world…"
        : "The agent has not selected its next priority yet.";
  }

  renderWork(snapshot.workOrder, snapshot.project);
  renderPlayer(snapshot.player);
  renderWorldState(snapshot.world);
}

function renderWork(work, project) {
  elements.workProgress.hidden = !work && !project;
  if (!work && !project) return;
  const denominator = Math.max(
    1,
    work?.minimumCount ?? project.progressTotal
  );
  const count = work?.progressCount ?? project.progressCount;
  const percent = Math.min(100, (count / denominator) * 100);
  elements.workLabel.textContent = work
    ? `Gathering ${readable(work.itemName)}`
    : project.stepTitle;
  elements.workCount.textContent = work
    ? `${work.progressCount}/${work.minimumCount}`
    : `${project.stepIndex}/${project.stepCount}`;
  elements.workFill.style.width = `${percent}%`;
}

function renderPlayer(player) {
  if (!player) {
    elements.playerName.textContent = "Offline";
    elements.position.textContent = "—";
    elements.dimension.textContent = "—";
    renderMeter(elements.health, 0);
    renderMeter(elements.food, 0);
    renderHotbar([], 0);
    renderInventory();
    return;
  }

  elements.playerName.textContent = player.username;
  elements.position.textContent =
    `${player.position.x} ${player.position.y} ${player.position.z}`;
  elements.dimension.textContent = readableDimension(player.dimension);
  renderMeter(elements.health, player.health);
  renderMeter(elements.food, player.food);
  renderHotbar(player.hotbar, player.selectedHotbarSlot);
  renderInventory(player.inventory);
  renderWorldLighting(player.timeOfDay);

  elements.experienceFill.style.width =
    `${Math.max(0, Math.min(100, player.experienceProgress * 100))}%`;
  elements.experienceLevel.textContent =
    player.experienceLevel > 0 ? String(player.experienceLevel) : "";

  const underwater = player.underwater && player.oxygen < 20;
  elements.playerHud.classList.toggle("has-oxygen", underwater);
  elements.oxygen.hidden = !underwater;
  elements.oxygen.replaceChildren();
  if (underwater) {
    const label = document.createElement("span");
    label.className = "oxygen-label";
    label.textContent = "AIR";
    elements.oxygen.append(label);
    for (let index = 0; index < Math.ceil(player.oxygen / 2); index += 1) {
      const bubble = document.createElement("span");
      bubble.className = "oxygen-bubble";
      elements.oxygen.append(bubble);
    }
  }
}

function renderMeter(container, value) {
  container.replaceChildren();
  for (let index = 0; index < 10; index += 1) {
    const pip = document.createElement("span");
    const remaining = value - index * 2;
    pip.className =
      remaining >= 2 ? "pip full" : remaining > 0 ? "pip half" : "pip";
    container.append(pip);
  }
}

function renderHotbar(items, selectedSlot) {
  elements.hotbar.replaceChildren();
  for (let slot = 0; slot < 9; slot += 1) {
    const item = items.find((candidate) => candidate.slot === slot);
    const element = document.createElement("div");
    element.className =
      slot === selectedSlot ? "hotbar-slot selected" : "hotbar-slot";
    element.setAttribute("aria-label", item?.displayName || `Empty slot ${slot + 1}`);

    if (item?.name) {
      element.append(itemIcon(item));
      const name = document.createElement("span");
      name.className = "item-abbreviation";
      name.textContent = abbreviate(item.displayName || item.name);
      element.append(name);
      if (item.count > 1) {
        const count = document.createElement("span");
        count.className = "item-count";
        count.textContent = String(item.count);
        element.append(count);
      }
    }
    elements.hotbar.append(element);
  }
}

function renderInventory(inventory) {
  const emptyInventory = {
    occupiedSlotCount: 0,
    totalItemCount: 0,
    main: Array.from({ length: 27 }, (_, slot) => ({ slot })),
    hotbar: Array.from({ length: 9 }, (_, slot) => ({ slot })),
    equipment: {
      head: { slot: 5 },
      chest: { slot: 6 },
      legs: { slot: 7 },
      feet: { slot: 8 },
      offhand: { slot: 45 }
    }
  };
  const state = inventory || emptyInventory;
  elements.inventoryCount.textContent = String(state.occupiedSlotCount);
  elements.inventoryTotal.textContent =
    `${state.totalItemCount} ${state.totalItemCount === 1 ? "item" : "items"}`;
  elements.inventorySlots.textContent =
    `${state.occupiedSlotCount} occupied ` +
    `${state.occupiedSlotCount === 1 ? "slot" : "slots"}`;

  elements.inventoryMain.replaceChildren(
    ...state.main.map((item) => inventorySlot(item))
  );
  elements.inventoryHotbar.replaceChildren(
    ...state.hotbar.map((item) => inventorySlot(item))
  );

  const equipmentLabels = [
    state.equipment.head,
    state.equipment.chest,
    state.equipment.legs,
    state.equipment.feet,
    state.equipment.offhand
  ];
  elements.inventoryEquipment.replaceChildren(
    ...equipmentLabels.map((item, index) => {
      const row = document.createElement("div");
      row.className = index === 4 ? "equipment-slot offhand" : "equipment-slot";
      row.append(inventorySlot(item));
      return row;
    })
  );
}

function inventorySlot(item) {
  const element = document.createElement("div");
  element.className = item?.name ? "inventory-slot occupied" : "inventory-slot";
  element.title = item?.displayName || "Empty";
  if (!item?.name) return element;

  element.append(itemIcon(item));
  const name = document.createElement("span");
  name.className = "inventory-slot-name";
  name.textContent = abbreviate(item.displayName || item.name);
  element.append(name);

  if (item.count > 1) {
    const count = document.createElement("span");
    count.className = "inventory-slot-count";
    count.textContent = String(item.count);
    element.append(count);
  }
  return element;
}

function itemIcon(item) {
  const image = document.createElement("img");
  image.className = "item-icon";
  image.src =
    `/textures/${encodeURIComponent(minecraftVersion)}/items/` +
    `${encodeURIComponent(item.name)}.png`;
  image.alt = "";
  image.addEventListener("error", () => image.remove(), { once: true });
  return image;
}

function renderWorldLighting(timeOfDay) {
  const time = Number(timeOfDay) || 0;
  const angle = ((time - 6000) / 24000) * Math.PI * 2;
  const daylight = Math.max(0, Math.min(1, (Math.cos(angle) + 1) / 2));
  const darkness = 1 - daylight;
  document.documentElement.style.setProperty(
    "--world-darkness",
    String((darkness * 0.72).toFixed(3))
  );
}

function renderWorldState(world) {
  const age = Date.now() - Date.parse(world?.lastEventAt || 0);
  const live = Number.isFinite(age) && age < 5000;
  elements.worldState.dataset.state = live ? "live" : "quiet";
  elements.worldState.lastChild.textContent = live ? " World live" : " World quiet";
}

function activityPhase(phase) {
  if (phase === "paused") return "AI paused";
  if (phase === "stopped") return "AI stopped";
  return phase;
}

function abbreviate(name) {
  const words = readable(name).split(/\s+/);
  if (words.length > 1) return words.map((word) => word[0]).join("").slice(0, 4);
  return words[0].slice(0, 5);
}

function readable(value) {
  return String(value || "")
    .replace(/^minecraft:/, "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function readableDimension(value) {
  return readable(String(value).split(":").at(-1));
}

async function refresh() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`Status ${response.status}`);
    render(await response.json());
  } catch {
    if (Date.now() - lastSuccess > 2500) {
      elements.connectionWarning.hidden = false;
    }
  }
}

renderHotbar([], 0);
renderMeter(elements.health, 0);
renderMeter(elements.food, 0);
void refresh();
setInterval(refresh, 750);

elements.inventoryButton.addEventListener("click", () => {
  elements.inventoryDialog.showModal();
});
elements.inventoryClose.addEventListener("click", () => {
  elements.inventoryDialog.close();
});
elements.inventoryDialog.addEventListener("click", (event) => {
  if (event.target === elements.inventoryDialog) {
    elements.inventoryDialog.close();
  }
});
