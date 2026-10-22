import type { Translation } from "./en";

/**
 * Spanish UI copy, neutral and professional (not Rioplatense slang —
 * that register is reserved for the AI's own generated content, which
 * comes from the server). Keys mirror `en.ts` exactly.
 */
export const es: Translation = {
  common: {
    cancel: "Cancelar",
    save: "Guardar",
    retry: "Reintentar",
    close: "Cerrar",
    loading: "Cargando…",
  },
  onboarding: {
    title: "Conectar con Bitacora",
    subtitle: "Ingresa la dirección del servidor y el token de acceso.",
    serverUrlLabel: "URL del servidor",
    tokenLabel: "Token de acceso",
    connect: "Conectar",
    validating: "Verificando conexión…",
    errorUnreachable: "No se pudo contactar al servidor. Revisa la URL y tu conexión.",
    errorUnauthorized: "El servidor rechazó el token.",
  },
  settings: {
    title: "Configuración",
    serverUrlLabel: "URL del servidor",
    tokenLabel: "Token de acceso",
    languageLabel: "Idioma",
    languageEnglish: "Inglés",
    languageSpanish: "Español",
    saved: "Configuración guardada.",
  },
  chat: {
    title: "Chat",
    composerPlaceholder: "Escribe algo…",
    send: "Enviar",
    thinking: "Pensando…",
    undo: "Deshacer",
    undoing: "Deshaciendo…",
    undoneNone: "No hay nada para deshacer.",
    undoneSome: "Se revirtieron {count} cambio(s).",
    citationsSheetTitle: "Entrada de origen",
    errorGeneric: "Algo salió mal. Intenta de nuevo.",
    errorNetwork: "Se perdió la conexión. Intenta de nuevo.",
    emptyHistory: "Todavía no hay mensajes. Escríbele algo a Bitacora.",
    derivationPending: "Todavía se está leyendo el archivo adjunto…",
    roleTool: "Paso de herramienta",
  },
  aboutYou: {
    title: "Lo que sé de ti",
    placeholder: "Próximamente.",
  },
};
