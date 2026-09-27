const SOURCE_TYPES = new Set(['website', 'image', 'dom', 'ocr', 'user']);
const PERSONAL_DATA_CATEGORIES = new Set(['email', 'phone', 'address', 'person_name', 'account_identifier', 'other']);

export function buildAnalysisProvenance(modelAnalysis, { capturedAt = new Date().toISOString(), sourceReferences = [] } = {}) {
  const allowedReferences = new Set(sourceReferences);
  const evidence = Array.isArray(modelAnalysis?.evidence) ? modelAnalysis.evidence : [];
  const cleanEvidence = evidence.slice(0, 8).map((item) => {
    const sourceType = String(item?.source_type || 'website');
    const sourceReference = String(item?.source_reference || '');
    const confidence = Number(item?.confidence);
    if (!SOURCE_TYPES.has(sourceType)) throw new Error('Analysis evidence has an unsupported source type.');
    if (!allowedReferences.has(sourceReference)) throw new Error('Analysis evidence cites an unknown source.');
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('Analysis evidence confidence must be between 0 and 1.');
    return {
      source_type: sourceType,
      source_reference: sourceReference,
      finding: String(item?.finding || '').trim().slice(0, 1000),
      confidence,
    };
  }).filter((item) => item.finding);

  const confidence = Number(modelAnalysis?.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('Analysis confidence must be between 0 and 1.');
  }
  const personalDataCategories = [...new Set(
    (Array.isArray(modelAnalysis?.personal_data_categories) ? modelAnalysis.personal_data_categories : [])
      .map(String)
      .filter((category) => PERSONAL_DATA_CATEGORIES.has(category)),
  )];

  return {
    evidence: cleanEvidence,
    confidence,
    source_captured_at: capturedAt,
    personal_data_detected: Boolean(modelAnalysis?.personal_data_detected || personalDataCategories.length),
    personal_data_categories: personalDataCategories,
  };
}

