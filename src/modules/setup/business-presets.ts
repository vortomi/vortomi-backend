import type { CustomFieldKind, TagTone } from '../../db/schema/enums.ts'

/** A field the welcome offers to create; product fields may name the preset's categories they go in. */
export interface PresetField {
  label: string
  kind: CustomFieldKind
  options?: string[]
  categories?: string[]
}

/**
 * What the welcome prepares for a business type (block C): a starting point the company edits
 * freely, never a lock. Names are what the company will see, so they are in Spanish.
 */
export interface BusinessPreset {
  categories: string[]
  productFields: PresetField[]
  contactFields: PresetField[]
  variantTypes: { name: string; values: string[] }[]
  tags: { name: string; tone: TagTone }[]
}

const FREQUENT = { name: 'Cliente frecuente', tone: 'green' } as const
const WHOLESALE = { name: 'Mayorista', tone: 'blue' } as const
const ZONE: PresetField = { label: 'Zona', kind: 'choice', options: ['Centro', 'Norte', 'Sur', 'Este', 'Oeste'] }
const BIRTHDAY: PresetField = { label: 'Cumpleaños', kind: 'date' }
const DELIVERY: PresetField = { label: 'Dirección de entrega', kind: 'text' }

/** For «Otro» and for types our team adds from the console, until they get their own. */
export const GENERAL_PRESET: BusinessPreset = {
  categories: ['General'],
  productFields: [{ label: 'Marca', kind: 'text' }],
  contactFields: [ZONE, BIRTHDAY],
  variantTypes: [],
  tags: [FREQUENT],
}

export const BUSINESS_PRESETS: Record<string, BusinessPreset> = {
  auto_parts: {
    categories: ['Frenos', 'Filtros', 'Suspensión', 'Eléctrico', 'Lubricantes'],
    productFields: [
      { label: 'Sirve para', kind: 'multi_choice', options: ['Corolla', 'Yaris', 'Hilux', 'Fortuner'], categories: ['Frenos', 'Filtros', 'Suspensión'] },
      { label: 'Lado', kind: 'choice', options: ['Izquierdo', 'Derecho', 'Ambos'], categories: ['Frenos', 'Suspensión'] },
      { label: 'Garantía (meses)', kind: 'number', categories: ['Eléctrico'] },
    ],
    contactFields: [{ label: 'Vehículo', kind: 'text' }, ZONE],
    variantTypes: [{ name: 'Marca', values: ['Original', 'Genérica'] }],
    tags: [FREQUENT, WHOLESALE, { name: 'Taller', tone: 'violet' }],
  },
  hardware: {
    categories: ['Herramientas', 'Electricidad', 'Plomería', 'Pinturas', 'Construcción'],
    productFields: [{ label: 'Marca', kind: 'text' }, { label: 'Medidas', kind: 'text' }],
    contactFields: [ZONE, { label: 'Tipo de cliente', kind: 'choice', options: ['Particular', 'Contratista', 'Empresa'] }],
    variantTypes: [{ name: 'Medida', values: ['1/2"', '3/4"', '1"'] }],
    tags: [FREQUENT, WHOLESALE],
  },
  apparel: {
    categories: ['Camisas', 'Pantalones', 'Vestidos', 'Calzado', 'Accesorios'],
    productFields: [{ label: 'Material', kind: 'text' }, { label: 'Género', kind: 'choice', options: ['Dama', 'Caballero', 'Niños', 'Unisex'] }],
    contactFields: [{ label: 'Talla habitual', kind: 'choice', options: ['XS', 'S', 'M', 'L', 'XL'] }, BIRTHDAY],
    variantTypes: [
      { name: 'Talla', values: ['S', 'M', 'L', 'XL'] },
      { name: 'Color', values: ['Negro', 'Blanco', 'Azul'] },
    ],
    tags: [FREQUENT, WHOLESALE],
  },
  food: {
    categories: ['Panes', 'Dulces', 'Bebidas', 'Combos'],
    productFields: [{ label: 'Ingredientes', kind: 'text' }, { label: 'Apto para', kind: 'multi_choice', options: ['Sin gluten', 'Sin azúcar', 'Vegano'] }],
    contactFields: [DELIVERY, ZONE],
    variantTypes: [{ name: 'Tamaño', values: ['Pequeño', 'Mediano', 'Grande'] }],
    tags: [FREQUENT, { name: 'Pedido por encargo', tone: 'amber' }],
  },
  pharmacy: {
    categories: ['Medicinas', 'Cuidado personal', 'Bebés', 'Vitaminas'],
    productFields: [
      { label: 'Principio activo', kind: 'text', categories: ['Medicinas'] },
      { label: 'Presentación', kind: 'choice', options: ['Tabletas', 'Jarabe', 'Crema', 'Inyectable'], categories: ['Medicinas'] },
      { label: 'Requiere récipe', kind: 'boolean', categories: ['Medicinas'] },
    ],
    contactFields: [{ label: 'Cédula', kind: 'text' }, DELIVERY],
    variantTypes: [],
    tags: [FREQUENT, { name: 'Tratamiento continuo', tone: 'teal' }],
  },
  furniture: {
    categories: ['Sala', 'Comedor', 'Dormitorio', 'Oficina', 'Decoración'],
    productFields: [{ label: 'Medidas', kind: 'text' }, { label: 'Material', kind: 'choice', options: ['Madera', 'Metal', 'Tela', 'Cuero'] }],
    contactFields: [DELIVERY, ZONE],
    variantTypes: [{ name: 'Color', values: ['Natural', 'Blanco', 'Negro'] }],
    tags: [FREQUENT, { name: 'Pedido a medida', tone: 'amber' }],
  },
  electronics: {
    categories: ['Teléfonos', 'Computación', 'Audio', 'Accesorios'],
    productFields: [{ label: 'Marca', kind: 'text' }, { label: 'Garantía (meses)', kind: 'number' }],
    contactFields: [ZONE, BIRTHDAY],
    variantTypes: [
      { name: 'Capacidad', values: ['64 GB', '128 GB', '256 GB'] },
      { name: 'Color', values: ['Negro', 'Blanco'] },
    ],
    tags: [FREQUENT, WHOLESALE],
  },
  beauty: {
    categories: ['Cabello', 'Uñas', 'Maquillaje', 'Cuidado de la piel'],
    productFields: [{ label: 'Marca', kind: 'text' }, { label: 'Tipo de piel', kind: 'multi_choice', options: ['Seca', 'Grasa', 'Mixta', 'Sensible'] }],
    contactFields: [BIRTHDAY, { label: 'Servicio preferido', kind: 'text' }],
    variantTypes: [{ name: 'Tono', values: ['Claro', 'Medio', 'Oscuro'] }],
    tags: [FREQUENT, { name: 'Cita pendiente', tone: 'amber' }],
  },
  health: {
    categories: ['Consultas', 'Exámenes', 'Tratamientos'],
    productFields: [{ label: 'Duración (minutos)', kind: 'number' }],
    contactFields: [
      { label: 'Cédula', kind: 'text' },
      { label: 'Fecha de nacimiento', kind: 'date' },
      { label: 'Seguro', kind: 'text' },
    ],
    variantTypes: [],
    tags: [{ name: 'Paciente nuevo', tone: 'blue' }, { name: 'Control', tone: 'teal' }],
  },
  technical_services: {
    categories: ['Diagnóstico', 'Reparación', 'Mantenimiento', 'Repuestos'],
    productFields: [{ label: 'Tiempo estimado (horas)', kind: 'number' }],
    contactFields: [{ label: 'Equipo o vehículo', kind: 'text' }, ZONE],
    variantTypes: [],
    tags: [FREQUENT, { name: 'En reparación', tone: 'amber' }],
  },
  other: GENERAL_PRESET,
}

export const presetFor = (businessType: string): BusinessPreset => BUSINESS_PRESETS[businessType] ?? GENERAL_PRESET
