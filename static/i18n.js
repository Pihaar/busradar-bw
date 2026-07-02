/**
 * Busradar BW — Internationalization (i18n) Strings
 * Loaded before app.js. Provides window.I18N with DE + EN translations.
 */
(function() {
  'use strict';

  var de = Object.create(null);
  var en = Object.create(null);

  // === STATUS & GENERAL ===
  de.connecting = 'Verbinde…';
  en.connecting = 'Connecting…';

  // === STATUS-BAR — Bus-Count, optional User-Count, Server-Time ===
  de.buses_count = '{count} Busse · {time}';
  en.buses_count = '{count} buses · {time}';
  de.buses_count_with_users = '{count} Busse · {users} · {time}';
  en.buses_count_with_users = '{count} buses · {users} · {time}';
  de.bus_count_one = '1 Bus · {time}';
  en.bus_count_one = '1 bus · {time}';
  de.bus_count_one_with_users = '1 Bus · {users} · {time}';
  en.bus_count_one_with_users = '1 bus · {users} · {time}';
  de.users_one = '1 Nutzer';
  en.users_one = '1 user';
  de.users_many = '{n} Nutzer';
  en.users_many = '{n} users';

  de.connection_error = 'Verbindungsfehler';
  en.connection_error = 'Connection error';

  de.no_buses = 'Kein Busverkehr zur Zeit';
  en.no_buses = 'No bus service at this time';

  de.no_realtime = 'Keine Echtzeit';
  en.no_realtime = 'No real-time data';

  de.stop_arrival_label = 'Ankunft';
  en.stop_arrival_label = 'Arrival';

  de.stop_departure_label = 'Abfahrt';
  en.stop_departure_label = 'Departure';

  de.stop_dwell_aria = 'Standzeit {n} Minuten';
  en.stop_dwell_aria = 'Dwell time {n} minutes';

  // === SEARCH ===
  de.search_placeholder = 'Haltestelle oder Linie…';
  en.search_placeholder = 'Stop or line…';

  de.no_results = 'Keine Ergebnisse';
  en.no_results = 'No results';

  // === TABS ===
  de.tab_stops = 'Halte';
  en.tab_stops = 'Stops';

  de.tab_departures = 'Abfahrten';
  en.tab_departures = 'Departures';

  de.tab_arrivals = 'Ankünfte';
  en.tab_arrivals = 'Arrivals';

  // === PANEL / JOURNEY ===
  de.loading_stops = 'Lade Halte…';
  en.loading_stops = 'Loading stops…';

  de.loading_departures = 'Lade Abfahrten…';
  en.loading_departures = 'Loading departures…';

  de.loading_route = 'Lade Route…';
  en.loading_route = 'Loading route…';

  de.route_unavailable = 'Routendaten nicht verfügbar';
  en.route_unavailable = 'Route data unavailable';

  de.journey_ended = 'Diese Fahrt ist beendet.';
  en.journey_ended = 'This journey has ended.';

  de.journey_cancelled = 'Diese Fahrt fällt aus.';
  en.journey_cancelled = 'This journey has been cancelled.';

  de.journey_poll_expired = 'Keine Echtzeitdaten. Seite neu laden.';
  en.journey_poll_expired = 'No real-time data. Reload page.';

  de.journey_started_announce = 'Bus {line} ist losgefahren';
  en.journey_started_announce = 'Bus {line} has started';

  de.journey_not_started = 'Dieser Bus ist noch nicht losgefahren.';
  en.journey_not_started = 'This bus has not started yet.';

  de.not_started_suffix = '— noch nicht gestartet';
  en.not_started_suffix = '— not yet started';

  de.journey_not_found = 'Fahrt nicht gefunden';
  en.journey_not_found = 'Journey not found';

  de.route_loaded = 'Route für Linie {line} geladen';
  en.route_loaded = 'Route for line {line} loaded';

  de.stop_fallback = 'Halt {idx}';
  en.stop_fallback = 'Stop {idx}';

  de.platform_prefix = 'Steig';
  en.platform_prefix = 'Platform';

  de.loading = 'Lade…';
  en.loading = 'Loading…';

  // === STATION BOARD ===
  de.departures_unavailable = 'Abfahrten nicht verfügbar';
  en.departures_unavailable = 'Departures unavailable';

  de.arrivals_unavailable = 'Ankünfte nicht verfügbar';
  en.arrivals_unavailable = 'Arrivals unavailable';

  de.dep_empty_minutes = 'Keine Abfahrten von diesem Steig in den nächsten {n} Minuten';
  en.dep_empty_minutes = 'No departures from this platform in the next {n} minutes';

  de.dep_empty_hours = 'Keine Abfahrten von diesem Steig in den nächsten {n} Stunden';
  en.dep_empty_hours = 'No departures from this platform in the next {n} hours';

  de.dep_empty_24h = 'Keine Abfahrten von diesem Steig in den nächsten 24 Stunden';
  en.dep_empty_24h = 'No departures from this platform in the next 24 hours';

  de.arr_empty_minutes = 'Keine Ankünfte an diesem Steig in den nächsten {n} Minuten';
  en.arr_empty_minutes = 'No arrivals at this platform in the next {n} minutes';

  de.arr_empty_hours = 'Keine Ankünfte an diesem Steig in den nächsten {n} Stunden';
  en.arr_empty_hours = 'No arrivals at this platform in the next {n} hours';

  de.arr_empty_24h = 'Keine Ankünfte an diesem Steig in den nächsten 24 Stunden';
  en.arr_empty_24h = 'No arrivals at this platform in the next 24 hours';

  de.load_more_dep = 'Weitere Abfahrten laden';
  en.load_more_dep = 'Load more departures';

  de.load_more_arr = 'Weitere Ankünfte laden';
  en.load_more_arr = 'Load more arrivals';

  de.departures_loaded = 'Abfahrten für {name} geladen';
  en.departures_loaded = 'Departures for {name} loaded';

  de.arr_from_prefix = 'von';
  en.arr_from_prefix = 'from';

  de.hafas_limit_hint = 'Eventuell werden nicht alle Fahrten angezeigt (Datenquelle limitiert)';
  en.hafas_limit_hint = 'Some journeys may not be shown (data source limited)';

  de.max_timeframe_hint = 'Keine weiteren Fahrten in den nächsten 24 Stunden';
  en.max_timeframe_hint = 'No further journeys in the next 24 hours';

  // === FILTER ===
  de.filter_all = 'Alle';
  en.filter_all = 'All';

  // === ACTIONS ===
  de.btn_follow = 'Bus folgen';
  en.btn_follow = 'Follow bus';

  de.btn_fitroute = 'Route zeigen';
  en.btn_fitroute = 'Show route';

  de.follow_active = 'Bus-Verfolgung aktiv';
  en.follow_active = 'Bus tracking active';

  de.follow_inactive = 'Bus-Verfolgung beendet';
  en.follow_inactive = 'Bus tracking ended';

  // === CONTROLS ===
  de.gps_center = 'Standort zentrieren';
  en.gps_center = 'Center on location';

  de.about_label = 'Über diese App';
  en.about_label = 'About this app';

  de.back_label = 'Zurück';
  en.back_label = 'Back';

  de.skip_link = 'Zum Steuerfeld springen';
  en.skip_link = 'Skip to controls';

  // === SETTINGS ===
  de.settings_label = 'Einstellungen';
  en.settings_label = 'Settings';

  de.setting_refresh = 'Aktualisierung';
  en.setting_refresh = 'Refresh rate';

  de.setting_animation = 'Bus-Animation';
  en.setting_animation = 'Bus animation';

  de.setting_posmode = 'Positionsmodus';
  en.setting_posmode = 'Position mode';

  de.setting_theme = 'Darstellung';
  en.setting_theme = 'Appearance';

  de.setting_location = 'Eigener Standort';
  en.setting_location = 'My location';

  de.location_unavailable = 'GPS nicht verfügbar';
  en.location_unavailable = 'GPS not available';

  de.location_denied = 'Standortzugriff verweigert';
  en.location_denied = 'Location access denied';

  de.setting_language = 'Sprache';
  en.setting_language = 'Language';

  de.setting_on = 'An';
  en.setting_on = 'On';

  de.setting_off = 'Aus';
  en.setting_off = 'Off';

  de.setting_interpolated = 'Interpoliert';
  en.setting_interpolated = 'Interpolated';

  de.setting_gps_only = 'Nur GPS';
  en.setting_gps_only = 'GPS only';

  de.setting_dark = 'Dunkel';
  en.setting_dark = 'Dark';

  de.setting_light = 'Hell';
  en.setting_light = 'Light';

  de.setting_reset = 'Cache & Einstellungen zurücksetzen';
  en.setting_reset = 'Reset cache & settings';

  de.setting_reset_confirm = 'Lokale Daten, Cache und Einstellungen wirklich zurücksetzen? Die Seite wird danach neu geladen.';
  en.setting_reset_confirm = 'Reset all local data, cache and settings? The page will reload afterwards.';

  de.setting_reset_aria = 'Lokalen Cache und Einstellungen zurücksetzen, Seite neu laden';
  en.setting_reset_aria = 'Reset local cache and settings, reload page';

  de.version_banner_text = 'Eine neue Version ist verfügbar.';
  en.version_banner_text = 'A new version is available.';

  de.connection_lost_terminal = 'Verbindung zum Server verloren.';
  en.connection_lost_terminal = 'Connection to server lost.';

  de.connection_lost = 'Verbindung unterbrochen — versuche neu zu verbinden …';
  en.connection_lost = 'Connection lost — reconnecting …';

  de.connection_stale = 'Daten sind nicht aktuell — Server-Probleme.';
  en.connection_stale = 'Data is stale — upstream problems.';

  de.terminal_reload = 'Neu laden';
  en.terminal_reload = 'Reload';

  de.version_banner_reload = 'Jetzt neu laden';
  en.version_banner_reload = 'Reload now';

  de.version_banner_dismiss = 'Hinweis schließen';
  en.version_banner_dismiss = 'Dismiss notice';

  de.announce_refresh = 'Aktualisierung: {n}s';
  en.announce_refresh = 'Refresh rate: {n}s';

  de.announce_animation_on = 'Bus-Animation: An';
  en.announce_animation_on = 'Bus animation: On';

  de.announce_animation_off = 'Bus-Animation: Aus';
  en.announce_animation_off = 'Bus animation: Off';

  de.announce_posmode_calc = 'Positionsmodus: Interpoliert';
  en.announce_posmode_calc = 'Position mode: Interpolated';

  de.announce_posmode_gps = 'Positionsmodus: Nur GPS';
  en.announce_posmode_gps = 'Position mode: GPS only';

  de.announce_posmode_gps_anim_off = 'Nur GPS — Animation deaktiviert';
  en.announce_posmode_gps_anim_off = 'GPS only — animation disabled';

  de.hint_animation_gps_only = 'Nicht verfügbar bei „Nur GPS“';
  en.hint_animation_gps_only = 'Not available with GPS only';

  de.announce_theme_dark = 'Dunkles Design';
  en.announce_theme_dark = 'Dark theme';

  de.announce_theme_light = 'Helles Design';
  en.announce_theme_light = 'Light theme';

  de.hint_animation_disabled = 'Animation deaktiviert (Zoom zu weit)';
  en.hint_animation_disabled = 'Animation disabled (zoomed out too far)';

  // === ACCESSIBILITY ===
  de.aria_map = 'Live-Buskarte Baden-Württemberg';
  en.aria_map = 'Live bus map Baden-Württemberg';

  de.aria_controls = 'Kartensteuerung';
  en.aria_controls = 'Map controls';

  de.aria_details = 'Fahrtdetails';
  en.aria_details = 'Journey details';

  de.aria_tabs = 'Ansichtswahl';
  en.aria_tabs = 'View selection';

  de.aria_filter = 'Linienfilter';
  en.aria_filter = 'Line filter';

  de.aria_panel_drag = 'Panel ziehen zum Vergrößern';
  en.aria_panel_drag = 'Drag panel to resize';

  de.aria_bus = 'Linie {line} Richtung {dir}, {delay}';
  en.aria_bus = 'Line {line} to {dir}, {delay}';

  de.close_label = 'Schließen';
  en.close_label = 'Close';

  // === ABOUT DIALOG ===
  de.about_title = 'Busradar BW';
  en.about_title = 'Busradar BW';

  de.about_intro = 'Live-Bustracker für Baden-Württemberg als Ersatz für die eingestellte App "DB Busradar Baden-Württemberg".';
  en.about_intro = 'Live bus tracker for Baden-Württemberg, replacing the discontinued "DB Busradar Baden-Württemberg" app.';

  de.about_data_heading = 'Datenquelle';
  en.about_data_heading = 'Data source';

  de.about_data_text = 'Echtzeit-Positionen via HAFAS API, gepusht über Server-Sent Events.';
  en.about_data_text = 'Real-time positions via HAFAS API, pushed via Server-Sent Events.';

  de.about_data_publisher = 'Herausgeber: DB Regio Bus Baden-Württemberg (dbregiobus-bawue.de).';
  en.about_data_publisher = 'Publisher: DB Regio Bus Baden-Württemberg (dbregiobus-bawue.de).';

  de.about_data_coverage = 'Nur Busse von DB Regio Bus (BRN, Südwestbus). Andere Betreiber wie rnv, SSB oder KVV sind nicht enthalten.';
  en.about_data_coverage = 'Only buses operated by DB Regio Bus (BRN, Südwestbus). Other operators such as rnv, SSB, or KVV are not included.';

  de.about_data_map = 'Kartendaten: © OpenStreetMap-Mitwirkende, © CARTO.';
  en.about_data_map = 'Map data: © OpenStreetMap contributors, © CARTO.';

  de.about_legal_heading = 'Rechtliches';
  en.about_legal_heading = 'Legal';

  de.about_legal_text = 'Privates, nicht-kommerzielles Projekt. Keine Gewähr für Vollständigkeit oder Korrektheit der angezeigten Daten.';
  en.about_legal_text = 'Private, non-commercial project. No guarantee for completeness or accuracy of displayed data.';

  de.about_source_heading = 'Quellcode';
  en.about_source_heading = 'Source code';

  de.about_source_text = 'Open Source auf GitHub:';
  en.about_source_text = 'Open source on GitHub:';

  de.about_source_link = 'github.com/Pihaar/busradar-bw';
  en.about_source_link = 'github.com/Pihaar/busradar-bw';

  de.about_privacy_heading = 'Datenschutz';
  en.about_privacy_heading = 'Privacy';

  de.about_privacy_text = 'Keine Cookies, kein Analytics, kein Cross-Site-Tracking. Der Webserver protokolliert IP, Pfad und Zeit im Zugriffslog für Betrieb und Missbrauchserkennung. Zusätzlich wird die IP kurzzeitig im Anwendungsspeicher gehalten, um die Anzahl aktiver Nutzer pro IP zu begrenzen (kein Profil, keine Persistenz, kein Export). Karten- und Schriftdaten werden direkt vom Browser bei OpenStreetMap und CARTO geladen; deren Datenschutzhinweise gelten zusätzlich. Fragen via GitHub-Issue.';
  en.about_privacy_text = 'No cookies, no analytics, no cross-site tracking. The web server logs IP, path and time in its access log for operations and abuse detection. The IP is additionally kept briefly in application memory to cap concurrent users per IP (no profile, no persistence, no export). Map and font assets are loaded directly by the browser from OpenStreetMap and CARTO; their privacy notices apply additionally. Questions via GitHub issue.';

  de.about_version_label = 'Version';
  en.about_version_label = 'Version';

  // === DELAY TEXT ===
  de.delay_ontime = '±0';
  en.delay_ontime = '±0';

  de.delay_format = '{sign}{min} min';
  en.delay_format = '{sign}{min} min';

  // === DAY OFFSET BADGE ===
  de.day_offset_badge = '+{n}d';
  en.day_offset_badge = '+{n}d';

  de.day_offset_aria = 'morgen';
  en.day_offset_aria = 'tomorrow';

  // === OFFLINE / ERROR ===
  de.offline_hint = 'Verbindungsproblem ({n} Versuche)';
  en.offline_hint = 'Connection issue ({n} attempts)';

  de.device_offline = 'Gerät offline';
  en.device_offline = 'Device offline';

  de.connection_restored = 'Verbindung wiederhergestellt';
  en.connection_restored = 'Connection restored';

  // === SHARE ===
  de.share_label = 'Teilen';
  en.share_label = 'Share';

  de.share_title_journey = '{line} → {dir} | Busradar BW';
  en.share_title_journey = '{line} → {dir} | Busradar BW';

  de.share_title_stop = '{name} | Busradar BW';
  en.share_title_stop = '{name} | Busradar BW';

  de.share_copied = 'Link kopiert';
  en.share_copied = 'Link copied';

  de.share_failed = 'Kopieren fehlgeschlagen';
  en.share_failed = 'Copy failed';

  window.I18N = { de: de, en: en };
})();
