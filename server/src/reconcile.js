export function explainLine({ name, expected, movements, counted }) {
  const adjusted = Number(expected) + Number(movements);
  const variance = Number(counted) - adjusted;
  const posted = variance > 0 ? `+${variance}` : String(variance);
  const narrative = `${name} was ${expected} when the count opened. Movements recorded after the snapshot total ${movements}. The reconciled book is ${adjusted}. The count is ${counted}, so approval posts ${posted}.`;
  return { expected: Number(expected), movements: Number(movements), adjusted, counted: Number(counted), variance, narrative };
}
