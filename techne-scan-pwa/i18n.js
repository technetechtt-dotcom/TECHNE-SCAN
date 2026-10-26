const STRINGS = {
  af: {
    Overview: "Oorsig",
    Assets: "Bates",
    Counts: "Tellings",
    Schedules: "Skedules",
    Inventory: "Voorraad",
    Operations: "Bedryf",
    Conflicts: "Konflikte",
    Scanner: "Skandeerder",
    Activity: "Aktiwiteit",
    Intelligence: "Intelligensie",
    Alerts: "Waarskuwings",
    Devices: "Toestelle",
    Branches: "Takke",
    Team: "Span",
    More: "Meer",
    Home: "Tuis",
  },
  tn: {
    Overview: "Kakaretso",
    Assets: "Dithoto",
    Counts: "Dipalo",
    Schedules: "Mananeo",
    Inventory: "Stock",
    Operations: "Tiro",
    Conflicts: "Dikgotlhang",
    Scanner: "Sekena",
    Activity: "Tiragatso",
    Intelligence: "Botlhale",
    Alerts: "Dikitsiso",
    Devices: "Didirisiwa",
    Branches: "Makala",
    Team: "Setlhopha",
    More: "Tse dingwe",
    Home: "Gae",
  },
};

globalThis.TechneI18n = {
  lang() {
    return localStorage.getItem("techne-lang") || "en";
  },
  set(lang) {
    localStorage.setItem("techne-lang", lang);
  },
  t(text) {
    return STRINGS[this.lang()]?.[text] || text;
  },
};
