const base = require("./structureArtifacts");

function normalizeIdArray(value, limit) {
  if (!Array.isArray(value)) return [];
  var seen = {};
  var items = [];
  var max = typeof limit === "number" ? limit : 8;
  for (var i = 0; i < value.length; i++) {
    var next = base.cleanText(value[i]);
    if (!next || seen[next]) continue;
    seen[next] = true;
    items.push(next);
    if (items.length >= max) break;
  }
  return items;
}

function buildCardId(prefix, parts) {
  var tokens = []
    .concat(parts || [])
    .map(function(part) { return base.slugify(part); })
    .filter(Boolean);
  return prefix + ":" + (tokens.length ? tokens.join(":") : "item");
}

function normalizeSectionCards(value, chapterMap, conceptNodes) {
  var source = Array.isArray(value) ? value : [];
  var knownConceptIds = {};
  var seen = {};
  var coveredChapterKeys = {};
  var cards = [];
  for (var i = 0; i < conceptNodes.length; i++) knownConceptIds[conceptNodes[i].id] = true;

  for (var j = 0; j < source.length; j++) {
    var entry = source[j] || {};
    var chapterNumber = Number.isFinite(Number(entry.chapterNumber || entry.chapter_num))
      ? Number(entry.chapterNumber || entry.chapter_num)
      : undefined;
    var chapterTitle = base.cleanText(entry.chapterTitle || entry.chapter_title);
    var sectionTitle = base.cleanText(entry.sectionTitle || entry.section_title || entry.title);
    if (!sectionTitle && !chapterTitle) continue;
    var id = base.cleanText(entry.id) || buildCardId("section", [chapterNumber || "x", chapterTitle, sectionTitle]);
    if (seen[id]) continue;
    seen[id] = true;
    coveredChapterKeys[String(chapterNumber || "") + "::" + String(chapterTitle || "").toLowerCase()] = true;
    cards.push({
      id: id,
      chapterNumber: chapterNumber,
      chapterTitle: chapterTitle || undefined,
      sectionTitle: sectionTitle || chapterTitle || "Seccion",
      summary: base.cleanText(entry.summary || entry.section_summary || entry.description) || undefined,
      purpose: base.cleanText(entry.purpose || entry.roleInArgument) || undefined,
      keyConceptIds: normalizeIdArray(entry.keyConceptIds, 8).filter(function(idValue) {
        return knownConceptIds[idValue];
      }),
      mentalModelIds: normalizeIdArray(entry.mentalModelIds, 6),
      evidenceHints: base.normalizeChapterMap(entry.evidenceHints).length > 0
        ? base.normalizeChapterMap(entry.evidenceHints).slice(0, 4)
        : chapterNumber || chapterTitle
          ? [{ chapterNumber: chapterNumber, chapterTitle: chapterTitle || undefined }]
          : [],
      teachingUse: base.cleanText(entry.teachingUse) || undefined,
      breadcrumb: base.cleanText(entry.breadcrumb) || undefined,
    });
  }

  if (cards.length === 0) {
    for (var k = 0; k < chapterMap.length; k++) {
      var chapter = chapterMap[k];
      var fallbackId = buildCardId("section", [chapter.chapterNumber || k + 1, chapter.chapterTitle || "seccion"]);
      if (seen[fallbackId]) continue;
      seen[fallbackId] = true;
      cards.push({
        id: fallbackId,
        chapterNumber: chapter.chapterNumber,
        chapterTitle: chapter.chapterTitle,
        sectionTitle: chapter.chapterTitle || ("Seccion " + String(k + 1)),
        evidenceHints: [chapter],
      });
    }
  }
  for (var fallbackIndex = 0; fallbackIndex < chapterMap.length; fallbackIndex++) {
    var fallbackChapter = chapterMap[fallbackIndex];
    var fallbackKey = String(fallbackChapter.chapterNumber || "") + "::" + String(fallbackChapter.chapterTitle || "").toLowerCase();
    if (coveredChapterKeys[fallbackKey]) continue;
    var fallbackSectionId = buildCardId("section", [fallbackChapter.chapterNumber || fallbackIndex + 1, fallbackChapter.chapterTitle || "seccion"]);
    if (seen[fallbackSectionId]) continue;
    seen[fallbackSectionId] = true;
    coveredChapterKeys[fallbackKey] = true;
    cards.push({
      id: fallbackSectionId,
      chapterNumber: fallbackChapter.chapterNumber,
      chapterTitle: fallbackChapter.chapterTitle,
      sectionTitle: fallbackChapter.chapterTitle || ("Seccion " + String(fallbackIndex + 1)),
      evidenceHints: [fallbackChapter],
    });
  }

  var sectionLimit = Math.max(24, Math.min(96, Math.max(cards.length, chapterMap.length * 3)));
  return cards.slice(0, sectionLimit);
}

function normalizeMentalModels(value, bookId, centralThesis, keyConcepts, chapterMap, conceptNodes, pedagogicalCompendium) {
  var source = Array.isArray(value) ? value : [];
  var knownConceptIds = {};
  var seen = {};
  var models = [];
  for (var i = 0; i < conceptNodes.length; i++) knownConceptIds[conceptNodes[i].id] = true;

  for (var j = 0; j < source.length; j++) {
    var entry = source[j] || {};
    var label = base.cleanText(entry.label || entry.name || entry.title);
    if (!label) continue;
    var id = base.cleanText(entry.id) || buildCardId("mental-model", [bookId, label]);
    if (seen[id]) continue;
    seen[id] = true;
    models.push({
      id: id,
      label: label,
      summary: base.cleanText(entry.summary || entry.description) || undefined,
      usedFor: base.cleanText(entry.usedFor || entry.teachingUse) || undefined,
      prerequisites: base.normalizeStringArray(entry.prerequisites, 6),
      commonMisread: base.cleanText(entry.commonMisread || entry.riskNote) || undefined,
      contrastsWith: base.normalizeStringArray(entry.contrastsWith, 4),
      relatedConceptIds: normalizeIdArray(entry.relatedConceptIds, 8).filter(function(idValue) {
        return knownConceptIds[idValue];
      }),
      evidenceHints: base.normalizeChapterMap(entry.evidenceHints).length > 0
        ? base.normalizeChapterMap(entry.evidenceHints).slice(0, 4)
        : chapterMap.slice(0, 2),
    });
  }

  if (models.length === 0) {
    var firstConcept = keyConcepts[0] || (conceptNodes[0] && conceptNodes[0].label) || "concepto central";
    models.push({
      id: buildCardId("mental-model", [bookId, firstConcept]),
      label: base.cleanText(firstConcept === "concepto central" ? "leer el nucleo del libro como un marco operativo" : firstConcept),
      summary: base.cleanText(centralThesis) || "Modelo mental central del libro.",
      usedFor: "Organizar la explicacion sin perder la relacion entre problema, criterio y consecuencia.",
      commonMisread: /confund|malinterpret|equivoc/i.test(pedagogicalCompendium || "")
        ? "El alumno puede repetir el termino sin distinguir su funcion en el argumento."
        : undefined,
      contrastsWith: [],
      relatedConceptIds: conceptNodes[0] ? [conceptNodes[0].id] : [],
      evidenceHints: chapterMap.slice(0, 2),
    });
  }

  return models.slice(0, 8);
}

function normalizeFundamentalDisagreements(value, bookId, centralThesis, keyConcepts, chapterMap, conceptNodes) {
  var source = Array.isArray(value) ? value : [];
  var knownConceptIds = {};
  var seen = {};
  var disagreements = [];
  for (var i = 0; i < conceptNodes.length; i++) knownConceptIds[conceptNodes[i].id] = true;

  for (var j = 0; j < source.length; j++) {
    var entry = source[j] || {};
    var question = base.cleanText(entry.question || entry.prompt || entry.label);
    if (!question) continue;
    var id = base.cleanText(entry.id) || buildCardId("disagreement", [bookId, question]);
    if (seen[id]) continue;
    seen[id] = true;
    disagreements.push({
      id: id,
      question: question,
      sideA: base.cleanText(entry.sideA || entry.positionA) || undefined,
      sideB: base.cleanText(entry.sideB || entry.positionB) || undefined,
      strongestArgumentA: base.cleanText(entry.strongestArgumentA) || undefined,
      strongestArgumentB: base.cleanText(entry.strongestArgumentB) || undefined,
      resolutionStyle: base.cleanText(entry.resolutionStyle) || undefined,
      epistemicStatus: base.cleanText(entry.epistemicStatus) || undefined,
      relatedConceptIds: normalizeIdArray(entry.relatedConceptIds, 8).filter(function(idValue) {
        return knownConceptIds[idValue];
      }),
      evidenceHints: base.normalizeChapterMap(entry.evidenceHints).length > 0
        ? base.normalizeChapterMap(entry.evidenceHints).slice(0, 4)
        : chapterMap.slice(0, 2),
    });
  }

  if (disagreements.length === 0 && (centralThesis || keyConcepts.length > 0)) {
    var focus = keyConcepts[0] || "la tesis del libro";
    disagreements.push({
      id: buildCardId("disagreement", [bookId, focus]),
      question: "Donde trazar la frontera entre " + focus + " y una simplificacion empobrecedora?",
      sideA: "Ordenar el problema con un criterio mas claro ayuda a pensar mejor.",
      sideB: "Reducir demasiado el criterio termina deformando aquello que se queria cuidar.",
      strongestArgumentA: "Sin algun recorte operativo, el alumno no ve como usar la idea.",
      strongestArgumentB: "Si el recorte domina la escena, el proxy reemplaza al fenomeno.",
      resolutionStyle: "Mantener la tension abierta y mostrar cuando cada lado gana fuerza.",
      epistemicStatus: "pedagogical",
      relatedConceptIds: conceptNodes[0] ? [conceptNodes[0].id] : [],
      evidenceHints: chapterMap.slice(0, 2),
    });
  }

  return disagreements.slice(0, 6);
}

function normalizeDepthProbes(value, bookId, keyConcepts, chapterMap, conceptNodes) {
  var source = Array.isArray(value) ? value : [];
  var knownConceptIds = {};
  var seen = {};
  var probes = [];
  for (var i = 0; i < conceptNodes.length; i++) knownConceptIds[conceptNodes[i].id] = true;

  for (var j = 0; j < source.length; j++) {
    var entry = source[j] || {};
    var question = base.cleanText(entry.question || entry.prompt);
    if (!question) continue;
    var id = base.cleanText(entry.id) || buildCardId("depth-probe", [bookId, question]);
    if (seen[id]) continue;
    seen[id] = true;
    probes.push({
      id: id,
      question: question,
      testsConceptIds: normalizeIdArray(entry.testsConceptIds, 8).filter(function(idValue) {
        return knownConceptIds[idValue];
      }),
      failureSignals: base.normalizeStringArray(entry.failureSignals, 6),
      goodAnswerShape: base.cleanText(entry.goodAnswerShape) || undefined,
      followUpIfWeak: base.cleanText(entry.followUpIfWeak) || undefined,
      difficulty: base.cleanText(entry.difficulty) || undefined,
      evidenceHints: base.normalizeChapterMap(entry.evidenceHints).length > 0
        ? base.normalizeChapterMap(entry.evidenceHints).slice(0, 4)
        : chapterMap.slice(0, 2),
    });
  }

  if (probes.length === 0) {
    var firstConcept = keyConcepts[0] || (conceptNodes[0] && conceptNodes[0].label) || "el concepto central";
    var secondConcept = keyConcepts[1] || (conceptNodes[1] && conceptNodes[1].label) || "sus consecuencias";
    probes.push({
      id: buildCardId("depth-probe", [bookId, firstConcept, secondConcept]),
      question: "Como distinguirias " + firstConcept + " de " + secondConcept + " en una situacion concreta sin repetir definiciones?",
      testsConceptIds: conceptNodes.slice(0, 2).map(function(node) { return node.id; }),
      failureSignals: [
        "Repite terminos del libro sin mostrar relacion funcional",
        "No distingue criterio, ejemplo y consecuencia",
      ],
      goodAnswerShape: "Conecta definicion, contraste y aplicacion situada.",
      followUpIfWeak: "Pedi que contraste una escena donde el concepto aclara y otra donde confunde.",
      difficulty: "medium",
      evidenceHints: chapterMap.slice(0, 2),
    });
  }

  return probes.slice(0, 8);
}

function normalizeTopicIndex(
  value,
  bookId,
  keyConcepts,
  chapterMap,
  conceptNodes,
  sectionCards,
  chapterCards,
  mentalModels,
  disagreements
) {
  var source = Array.isArray(value) ? value : [];
  var knownConceptIds = {};
  var knownSectionIds = {};
  var seen = {};
  var topics = [];
  for (var i = 0; i < conceptNodes.length; i++) knownConceptIds[conceptNodes[i].id] = true;
  for (var j = 0; j < sectionCards.length; j++) knownSectionIds[sectionCards[j].id] = true;

  function pushTopic(entry) {
    var label = base.cleanText(entry && (entry.label || entry.topic || entry.title));
    if (!label) return;
    var id = base.cleanText(entry.id) || buildCardId("topic", [bookId, label]);
    if (seen[id]) return;
    seen[id] = true;
    topics.push({
      id: id,
      label: label,
      summary: base.cleanText(entry.summary || entry.description) || undefined,
      aliases: base.normalizeStringArray(entry.aliases, 6),
      chapterRefs: base.normalizeChapterMap(entry.chapterRefs || entry.evidenceHints).slice(0, 4),
      sectionIds: normalizeIdArray(entry.sectionIds, 12).filter(function(idValue) { return knownSectionIds[idValue]; }),
      relatedConceptIds: normalizeIdArray(entry.relatedConceptIds, 8).filter(function(idValue) { return knownConceptIds[idValue]; }),
      evidenceHints: base.normalizeChapterMap(entry.evidenceHints || entry.chapterRefs).slice(0, 4),
    });
  }

  for (var sourceIndex = 0; sourceIndex < source.length; sourceIndex++) {
    pushTopic(source[sourceIndex] || {});
  }
  for (var conceptIndex = 0; conceptIndex < conceptNodes.length; conceptIndex++) {
    var concept = conceptNodes[conceptIndex];
    pushTopic({
      id: buildCardId("topic", [bookId, concept.label]),
      label: concept.label,
      summary: concept.summary,
      chapterRefs: chapterMap.slice(Math.max(0, conceptIndex - 1), conceptIndex + 1),
      relatedConceptIds: [concept.id],
      evidenceHints: chapterMap.slice(Math.max(0, conceptIndex - 1), conceptIndex + 1),
    });
  }
  for (var conceptLabelIndex = 0; conceptLabelIndex < keyConcepts.length; conceptLabelIndex++) {
    pushTopic({
      id: buildCardId("topic", [bookId, keyConcepts[conceptLabelIndex]]),
      label: keyConcepts[conceptLabelIndex],
      chapterRefs: chapterMap.slice(Math.max(0, conceptLabelIndex - 1), conceptLabelIndex + 1),
      evidenceHints: chapterMap.slice(Math.max(0, conceptLabelIndex - 1), conceptLabelIndex + 1),
    });
  }
  for (var chapterIndex = 0; chapterIndex < chapterCards.length; chapterIndex++) {
    var chapterCard = chapterCards[chapterIndex];
    pushTopic({
      id: buildCardId("topic", [bookId, chapterCard.chapterNumber || chapterIndex + 1, chapterCard.chapterTitle || "capitulo"]),
      label: chapterCard.chapterTitle || ("Capitulo " + String(chapterCard.chapterNumber || chapterIndex + 1)),
      summary: chapterCard.localThesis || chapterCard.roleInBook,
      chapterRefs: chapterCard.evidenceHints || [],
      sectionIds: chapterCard.sectionIds || [],
      relatedConceptIds: chapterCard.keyConceptIds || [],
      evidenceHints: chapterCard.evidenceHints || [],
    });
  }
  for (var sectionIndex = 0; sectionIndex < sectionCards.length; sectionIndex++) {
    var sectionCard = sectionCards[sectionIndex];
    pushTopic({
      id: buildCardId("topic", [bookId, sectionCard.chapterNumber || sectionIndex + 1, sectionCard.sectionTitle]),
      label: sectionCard.sectionTitle,
      summary: sectionCard.summary || sectionCard.purpose,
      chapterRefs: sectionCard.evidenceHints || [],
      sectionIds: [sectionCard.id],
      relatedConceptIds: sectionCard.keyConceptIds || [],
      evidenceHints: sectionCard.evidenceHints || [],
    });
  }
  for (var modelIndex = 0; modelIndex < mentalModels.length; modelIndex++) {
    var model = mentalModels[modelIndex];
    pushTopic({
      id: buildCardId("topic", [bookId, model.label]),
      label: model.label,
      summary: [model.summary, model.usedFor].filter(Boolean).join(" "),
      aliases: model.contrastsWith || [],
      chapterRefs: model.evidenceHints || [],
      relatedConceptIds: model.relatedConceptIds || [],
      evidenceHints: model.evidenceHints || [],
    });
  }
  for (var disagreementIndex = 0; disagreementIndex < disagreements.length; disagreementIndex++) {
    var disagreement = disagreements[disagreementIndex];
    pushTopic({
      id: buildCardId("topic", [bookId, disagreement.question]),
      label: disagreement.question,
      summary: [disagreement.sideA, disagreement.sideB].filter(Boolean).join(" "),
      chapterRefs: disagreement.evidenceHints || [],
      relatedConceptIds: disagreement.relatedConceptIds || [],
      evidenceHints: disagreement.evidenceHints || [],
    });
  }

  return topics.slice(0, Math.max(24, Math.min(64, chapterMap.length + sectionCards.length)));
}

function normalizeDifferenceCards(
  value,
  bookId,
  keyConcepts,
  chapterMap,
  conceptNodes,
  sectionCards,
  disagreements,
  relationEdges,
  mentalModels
) {
  var source = Array.isArray(value) ? value : [];
  var knownConceptIds = {};
  var knownSectionIds = {};
  var seen = {};
  var cards = [];
  for (var i = 0; i < conceptNodes.length; i++) knownConceptIds[conceptNodes[i].id] = true;
  for (var j = 0; j < sectionCards.length; j++) knownSectionIds[sectionCards[j].id] = true;

  function pushDifference(entry) {
    var label = base.cleanText(entry && (entry.label || entry.question || entry.title));
    if (!label) return;
    var id = base.cleanText(entry.id) || buildCardId("difference", [bookId, label]);
    if (seen[id]) return;
    seen[id] = true;
    cards.push({
      id: id,
      label: label,
      question: base.cleanText(entry.question) || undefined,
      summary: base.cleanText(entry.summary || entry.description) || undefined,
      leftLabel: base.cleanText(entry.leftLabel || entry.leftTerm || entry.sideA) || undefined,
      rightLabel: base.cleanText(entry.rightLabel || entry.rightTerm || entry.sideB) || undefined,
      chapterRefs: base.normalizeChapterMap(entry.chapterRefs || entry.evidenceHints).slice(0, 4),
      sectionIds: normalizeIdArray(entry.sectionIds, 12).filter(function(idValue) { return knownSectionIds[idValue]; }),
      relatedConceptIds: normalizeIdArray(entry.relatedConceptIds, 8).filter(function(idValue) { return knownConceptIds[idValue]; }),
      evidenceHints: base.normalizeChapterMap(entry.evidenceHints || entry.chapterRefs).slice(0, 4),
    });
  }

  for (var sourceIndex = 0; sourceIndex < source.length; sourceIndex++) {
    pushDifference(source[sourceIndex] || {});
  }
  for (var disagreementIndex = 0; disagreementIndex < disagreements.length; disagreementIndex++) {
    var disagreement = disagreements[disagreementIndex];
    pushDifference({
      id: buildCardId("difference", [bookId, disagreement.question]),
      label: disagreement.question,
      question: disagreement.question,
      summary: [disagreement.strongestArgumentA, disagreement.strongestArgumentB].filter(Boolean).join(" "),
      leftLabel: disagreement.sideA,
      rightLabel: disagreement.sideB,
      relatedConceptIds: disagreement.relatedConceptIds || [],
      chapterRefs: disagreement.evidenceHints || [],
      evidenceHints: disagreement.evidenceHints || [],
    });
  }
  for (var relationIndex = 0; relationIndex < relationEdges.length; relationIndex++) {
    var relation = relationEdges[relationIndex];
    if (relation.type !== "contrasts_with" && relation.type !== "misread_as") continue;
    var leftConcept = conceptNodes.find(function(node) { return node.id === relation.from; });
    var rightConcept = conceptNodes.find(function(node) { return node.id === relation.to; });
    pushDifference({
      id: buildCardId("difference", [bookId, leftConcept && leftConcept.label, rightConcept && rightConcept.label]),
      label: [leftConcept && leftConcept.label, rightConcept && rightConcept.label].filter(Boolean).join(" vs "),
      summary: relation.summary,
      leftLabel: leftConcept && leftConcept.label,
      rightLabel: rightConcept && rightConcept.label,
      relatedConceptIds: [relation.from, relation.to],
      chapterRefs: relation.evidenceHints || [],
      evidenceHints: relation.evidenceHints || [],
    });
  }
  for (var modelIndex = 0; modelIndex < mentalModels.length; modelIndex++) {
    var model = mentalModels[modelIndex];
    for (var contrastIndex = 0; contrastIndex < (model.contrastsWith || []).length; contrastIndex++) {
      var contrast = model.contrastsWith[contrastIndex];
      pushDifference({
        id: buildCardId("difference", [bookId, model.label, contrast]),
        label: model.label + " vs " + contrast,
        summary: model.commonMisread || model.summary,
        leftLabel: model.label,
        rightLabel: contrast,
        relatedConceptIds: model.relatedConceptIds || [],
        chapterRefs: model.evidenceHints || chapterMap.slice(0, 2),
        evidenceHints: model.evidenceHints || chapterMap.slice(0, 2),
      });
    }
  }
  if (cards.length === 0 && keyConcepts.length >= 2) {
    pushDifference({
      label: keyConcepts[0] + " vs " + keyConcepts[1],
      summary: "Distinguir estos ejes evita mezclar problema, criterio y consecuencia.",
      leftLabel: keyConcepts[0],
      rightLabel: keyConcepts[1],
      chapterRefs: chapterMap.slice(0, 2),
      evidenceHints: chapterMap.slice(0, 2),
    });
  }

  return cards.slice(0, Math.max(8, Math.min(24, keyConcepts.length + disagreements.length + 6)));
}

function normalizeChapterCards(value, chapterMap, conceptNodes, sectionCards, mentalModels, disagreements, depthProbes) {
  var source = Array.isArray(value) ? value : [];
  var knownConceptIds = {};
  var knownSectionIds = {};
  var knownModelIds = {};
  var knownDisagreementIds = {};
  var knownProbeIds = {};
  var seen = {};
  var coveredChapterKeys = {};
  var cards = [];

  for (var i = 0; i < conceptNodes.length; i++) knownConceptIds[conceptNodes[i].id] = true;
  for (var j = 0; j < sectionCards.length; j++) knownSectionIds[sectionCards[j].id] = true;
  for (var k = 0; k < mentalModels.length; k++) knownModelIds[mentalModels[k].id] = true;
  for (var m = 0; m < disagreements.length; m++) knownDisagreementIds[disagreements[m].id] = true;
  for (var n = 0; n < depthProbes.length; n++) knownProbeIds[depthProbes[n].id] = true;

  for (var p = 0; p < source.length; p++) {
    var entry = source[p] || {};
    var chapterNumber = Number.isFinite(Number(entry.chapterNumber || entry.chapter_num))
      ? Number(entry.chapterNumber || entry.chapter_num)
      : undefined;
    var chapterTitle = base.cleanText(entry.chapterTitle || entry.chapter_title || entry.title);
    if (!chapterTitle && !Number.isFinite(Number(chapterNumber))) continue;
    var id = base.cleanText(entry.id) || buildCardId("chapter", [chapterNumber || "x", chapterTitle || "capitulo"]);
    if (seen[id]) continue;
    seen[id] = true;
    coveredChapterKeys[String(chapterNumber || "") + "::" + String(chapterTitle || "").toLowerCase()] = true;
    cards.push({
      id: id,
      chapterNumber: chapterNumber,
      chapterTitle: chapterTitle || undefined,
      roleInBook: base.cleanText(entry.roleInBook || entry.summary || entry.purpose) || undefined,
      localThesis: base.cleanText(entry.localThesis) || undefined,
      keyConceptIds: normalizeIdArray(entry.keyConceptIds, 8).filter(function(idValue) { return knownConceptIds[idValue]; }),
      sectionIds: normalizeIdArray(entry.sectionIds, 8).filter(function(idValue) { return knownSectionIds[idValue]; }),
      mentalModelIds: normalizeIdArray(entry.mentalModelIds, 6).filter(function(idValue) { return knownModelIds[idValue]; }),
      disagreementIds: normalizeIdArray(entry.disagreementIds, 6).filter(function(idValue) { return knownDisagreementIds[idValue]; }),
      depthProbeIds: normalizeIdArray(entry.depthProbeIds, 6).filter(function(idValue) { return knownProbeIds[idValue]; }),
      evidenceHints: base.normalizeChapterMap(entry.evidenceHints).length > 0
        ? base.normalizeChapterMap(entry.evidenceHints).slice(0, 4)
        : chapterNumber || chapterTitle
          ? [{ chapterNumber: chapterNumber, chapterTitle: chapterTitle || undefined }]
          : [],
      teachingUse: base.cleanText(entry.teachingUse) || undefined,
    });
  }

  if (cards.length === 0) {
    for (var q = 0; q < chapterMap.length; q++) {
      var chapter = chapterMap[q];
      var chapterId = buildCardId("chapter", [chapter.chapterNumber || q + 1, chapter.chapterTitle || "capitulo"]);
      if (seen[chapterId]) continue;
      seen[chapterId] = true;
      cards.push({
        id: chapterId,
        chapterNumber: chapter.chapterNumber,
        chapterTitle: chapter.chapterTitle,
        roleInBook: q === 0
          ? "Abre el problema y fija el marco de lectura."
          : q === chapterMap.length - 1
            ? "Reordena las piezas y deja visible la apuesta final del libro."
            : "Desarrolla una pieza necesaria del arco argumental.",
        localThesis: undefined,
        keyConceptIds: conceptNodes.slice(q, q + 2).map(function(node) { return node.id; }),
        sectionIds: sectionCards
          .filter(function(section) { return section.chapterNumber === chapter.chapterNumber; })
          .slice(0, 4)
          .map(function(section) { return section.id; }),
        mentalModelIds: mentalModels.slice(0, 2).map(function(model) { return model.id; }),
        disagreementIds: disagreements.slice(0, 1).map(function(item) { return item.id; }),
        depthProbeIds: depthProbes.slice(0, 1).map(function(item) { return item.id; }),
        evidenceHints: [chapter],
        teachingUse: "Ubicar este capitulo dentro del arco completo antes de bajar al detalle.",
      });
    }
  }
  for (var chapterIndex = 0; chapterIndex < chapterMap.length; chapterIndex++) {
    var fallbackChapter = chapterMap[chapterIndex];
    var fallbackKey = String(fallbackChapter.chapterNumber || "") + "::" + String(fallbackChapter.chapterTitle || "").toLowerCase();
    if (coveredChapterKeys[fallbackKey]) continue;
    var fallbackChapterId = buildCardId("chapter", [fallbackChapter.chapterNumber || chapterIndex + 1, fallbackChapter.chapterTitle || "capitulo"]);
    if (seen[fallbackChapterId]) continue;
    seen[fallbackChapterId] = true;
    coveredChapterKeys[fallbackKey] = true;
    cards.push({
      id: fallbackChapterId,
      chapterNumber: fallbackChapter.chapterNumber,
      chapterTitle: fallbackChapter.chapterTitle,
      roleInBook: chapterIndex === 0
        ? "Abre el problema y fija el marco de lectura."
        : chapterIndex === chapterMap.length - 1
          ? "Reordena las piezas y deja visible la apuesta final del libro."
          : "Desarrolla una pieza necesaria del arco argumental.",
      localThesis: undefined,
      keyConceptIds: conceptNodes.slice(chapterIndex, chapterIndex + 2).map(function(node) { return node.id; }),
      sectionIds: sectionCards
        .filter(function(section) { return section.chapterNumber === fallbackChapter.chapterNumber; })
        .slice(0, 4)
        .map(function(section) { return section.id; }),
      mentalModelIds: mentalModels.slice(0, 2).map(function(model) { return model.id; }),
      disagreementIds: disagreements.slice(0, 1).map(function(item) { return item.id; }),
      depthProbeIds: depthProbes.slice(0, 1).map(function(item) { return item.id; }),
      evidenceHints: [fallbackChapter],
      teachingUse: "Ubicar este capitulo dentro del arco completo antes de bajar al detalle.",
    });
  }

  return cards.slice(0, Math.max(24, chapterMap.length));
}

function buildContextCoreLite(bookId, payload) {
  var chapters = base.normalizeDetectedChapters(payload.chapters);
  var chapterMap = base.normalizeChapterMap(chapters);
  var argumentativeArc = base.normalizeStringArray(payload.argumentativeArc, 6);
  var keyConcepts = base.normalizeStringArray(payload.keyConcepts, 8);
  var centralThesis = base.cleanText(payload.centralThesis);
  var pedagogicalCompendium = base.cleanText(payload.pedagogicalCompendium);
  var title = base.cleanText(payload.title) || "Libro desconocido";
  var author = base.cleanText(payload.author);
  var sourceLanguage = base.cleanText(payload.sourceLanguage || payload.source_language);
  var structureHealth = payload.structureHealth && typeof payload.structureHealth === "object"
    ? payload.structureHealth
    : undefined;

  var conceptSeed = []
    .concat(
      keyConcepts.map(function(label) {
        return {
          id: base.buildConceptId(bookId, label),
          label: label,
          pedagogicalRole: "core",
        };
      })
    )
    .concat(Array.isArray(payload.conceptNodes) ? payload.conceptNodes : [])
    .concat(
      (Array.isArray(payload.relationEdges) ? payload.relationEdges : []).flatMap(function(entry) {
        var from = base.cleanText(entry && (entry.from || entry.fromId));
        var to = base.cleanText(entry && (entry.to || entry.toId));
        return [from, to]
          .filter(Boolean)
          .map(function(reference) {
            return {
              id: reference,
              label: base.cleanText(reference.split(":").pop() || reference).replace(/[-_]+/g, " "),
              pedagogicalRole: "supporting",
            };
          });
      })
    );

  var conceptNodes = base.normalizeConceptNodes(conceptSeed, bookId);
  var relationEdges = base.normalizeRelationEdges(payload.relationEdges, conceptNodes, chapterMap);
  var pedagogicalRisks = base.normalizePedagogicalRisks(payload.pedagogicalRisks);
  var sectionCards = normalizeSectionCards(
    (Array.isArray(payload.sectionCards) ? payload.sectionCards : []).concat(
      Array.isArray(payload.sectionCandidates) ? payload.sectionCandidates : []
    ),
    chapterMap,
    conceptNodes
  );
  var mentalModels = normalizeMentalModels(
    payload.mentalModels,
    bookId,
    centralThesis,
    keyConcepts,
    chapterMap,
    conceptNodes,
    pedagogicalCompendium
  );
  var fundamentalDisagreements = normalizeFundamentalDisagreements(
    payload.fundamentalDisagreements,
    bookId,
    centralThesis,
    keyConcepts,
    chapterMap,
    conceptNodes
  );
  var depthProbes = normalizeDepthProbes(
    payload.depthProbes,
    bookId,
    keyConcepts,
    chapterMap,
    conceptNodes
  );
  var chapterCards = normalizeChapterCards(
    payload.chapterCards,
    chapterMap,
    conceptNodes,
    sectionCards,
    mentalModels,
    fundamentalDisagreements,
    depthProbes
  );
  var topicIndex = normalizeTopicIndex(
    payload.topicIndex,
    bookId,
    keyConcepts,
    chapterMap,
    conceptNodes,
    sectionCards,
    chapterCards,
    mentalModels,
    fundamentalDisagreements
  );
  var differenceCards = normalizeDifferenceCards(
    payload.differenceCards,
    bookId,
    keyConcepts,
    chapterMap,
    conceptNodes,
    sectionCards,
    fundamentalDisagreements,
    relationEdges,
    mentalModels
  );
  var crossBookSynthesis = base.normalizeCrossBookSynthesis(payload.crossBookSynthesis);

  var fingerprintPayload = JSON.stringify({
    bookId: bookId,
    title: title,
    author: author,
    sourceLanguage: sourceLanguage,
    chapterMap: chapterMap,
    centralThesis: centralThesis,
    argumentativeArc: argumentativeArc,
    keyConcepts: keyConcepts,
    conceptNodes: conceptNodes,
    relationEdges: relationEdges,
    pedagogicalRisks: pedagogicalRisks,
    chapterCards: chapterCards,
    sectionCards: sectionCards,
    topicIndex: topicIndex,
    differenceCards: differenceCards,
    mentalModels: mentalModels,
    fundamentalDisagreements: fundamentalDisagreements,
    depthProbes: depthProbes,
    crossBookSynthesis: crossBookSynthesis,
    pedagogicalCompendium: pedagogicalCompendium.slice(0, 1200),
    structureHealth: structureHealth || null,
  });
  var hash = require("crypto").createHash("sha1").update(fingerprintPayload).digest("hex").slice(0, 12);

  return {
    id: "ctx-book-" + bookId,
    scope: "book",
    bookIds: [String(bookId)],
    version: "ctx-v2-" + hash,
    generatedAt: new Date().toISOString(),
    sourceFingerprint: String(bookId) + ":" + hash,
    books: [
      {
        bookId: String(bookId),
        title: title,
        author: author || undefined,
        sourceLanguage: sourceLanguage || undefined,
        sectionOutline: chapters,
        chapterMap: chapterMap,
        centralThesis: centralThesis || undefined,
        argumentativeArc: argumentativeArc,
        keyConcepts: keyConcepts,
        pedagogicalCompendium: pedagogicalCompendium ? pedagogicalCompendium.slice(0, 1200) : undefined,
        structureHealth: structureHealth,
        conceptNodes: conceptNodes,
        relationEdges: relationEdges,
        pedagogicalRisks: pedagogicalRisks,
        chapterCards: chapterCards,
        sectionCards: sectionCards,
        topicIndex: topicIndex,
        differenceCards: differenceCards,
        mentalModels: mentalModels,
        fundamentalDisagreements: fundamentalDisagreements,
        depthProbes: depthProbes,
      }
    ],
    crossBookSynthesis: crossBookSynthesis,
    retrievalHints: {
      factualPrioritySignals: chapterMap
        .map(function(chapter) { return String(chapter.chapterTitle || "").trim(); })
        .filter(Boolean)
        .slice(0, 8),
      conceptualPrioritySignals: []
        .concat(centralThesis ? [centralThesis] : [])
        .concat(keyConcepts)
        .concat(conceptNodes.map(function(node) { return node.label; }))
        .concat(topicIndex.map(function(topic) { return topic.label; }))
        .concat(differenceCards.map(function(item) { return item.label; }))
        .concat(mentalModels.map(function(model) { return model.label; }))
        .concat(fundamentalDisagreements.map(function(item) { return item.question; }))
        .slice(0, 10),
      knownWeakSpots: []
        .concat(chapterMap.length === 0 ? ["chapter-map-missing"] : [])
        .concat(sectionCards.length === 0 ? ["section-cards-missing"] : [])
        .concat(centralThesis ? [] : ["central-thesis-missing"])
        .concat(
          structureHealth && structureHealth.sourceDetectionIncomplete
            ? ["structure-source-incomplete"]
            : []
        )
        .concat(pedagogicalRisks.map(function(risk) { return risk.label; }).slice(0, 4)),
    }
  };
}

module.exports = Object.assign({}, base, {
  buildContextCoreLite: buildContextCoreLite,
  normalizeSectionCards: normalizeSectionCards,
  normalizeMentalModels: normalizeMentalModels,
  normalizeFundamentalDisagreements: normalizeFundamentalDisagreements,
  normalizeDepthProbes: normalizeDepthProbes,
});
