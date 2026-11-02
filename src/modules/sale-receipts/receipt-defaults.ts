// What a company's receipt says until it writes its own: a footer suggested by its business type
// (block C, «el rubro prellena») and a number prefix from its name. Spanish: the customer reads it.

const THANKS = '¡Gracias por su compra!'

/** The footer each business type starts with; the company edits it freely in Ajustes → Recibo. */
const FOOTERS: Record<string, string> = {
  auto_parts: `Garantía de 30 días por defecto de fábrica, presentando este recibo. No cubre mala instalación. ${THANKS}`,
  hardware: `Cambios dentro de los 7 días siguientes, con este recibo y el producto en su empaque. ${THANKS}`,
  apparel: `Cambios por talla dentro de los 7 días siguientes, con este recibo y la etiqueta puesta. ${THANKS}`,
  food: `${THANKS} ¡Buen provecho!`,
  pharmacy: `Los medicamentos no tienen cambio ni devolución. ${THANKS}`,
  furniture: `Garantía según las condiciones del fabricante, presentando este recibo. ${THANKS}`,
  electronics: `Garantía de 3 meses por defecto de fábrica, presentando este recibo. ${THANKS}`,
  beauty: '¡Gracias por tu visita! Te esperamos pronto.',
  health: '¡Gracias por confiar en nosotros!',
  technical_services: 'Garantía del servicio por 30 días, presentando este recibo. ¡Gracias por su confianza!',
}

export function suggestedFooter(businessType: string | null): string {
  return (businessType && FOOTERS[businessType]) || THANKS
}

/** "Agua Potable La Campiña" → "APC": the initials of its words of 3 letters or more (up to 4). */
export function suggestedPrefix(companyName: string): string {
  const initials = companyName
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((word) => word.length >= 3)
    .map((word) => word[0])
    .join('')
    .slice(0, 4)
  return initials || 'REC'
}

/** "APC-000050". */
export const receiptCode = (prefix: string, number: number) => `${prefix}-${String(number).padStart(6, '0')}`
