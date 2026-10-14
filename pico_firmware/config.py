"""Configuration locale du Pico BioSonification."""

# WPA2 exige au moins 8 caractères. Changez ce mot de passe avant une
# utilisation en public.
WIFI_SSID = "Plante-Musicale"
WIFI_PASSWORD = "biosonique"
WIFI_COUNTRY = "FR"
WIFI_CHANNEL = 6
WIFI_MAX_CLIENTS = 4

# Sortie impulsionnelle (555/comparateur) du capteur MIDI Sprout.
# GP15 correspond à la broche physique 20 du Pico WH.
SENSOR_PIN = 15

# Fréquence du compteur PIO. Un pas de comptage prend trois cycles, donc
# 3 MHz donne une résolution de 1 µs.
PIO_FREQUENCY_HZ = 3_000_000

# Bornes de plausibilité. Le capteur tourne autour de 50 Hz (20 000 µs) ;
# tout ce qui sort de cette fenêtre est un parasite de commutation.
MIN_PERIOD_US = 100
MAX_PERIOD_US = 250_000

# Dossier de l'interface web sur le système de fichiers du Pico.
STATIC_DIR = "app"

# Anneau de mesures conservées en RAM et débit du flux SSE.
RING_SIZE = 512
MAX_POINTS_PER_RESPONSE = 160
STREAM_BATCH = 48
STREAM_INTERVAL_MS = 30
# Mesures renvoyées dès l'ouverture du flux, pour que le graphe soit rempli.
STREAM_PRIME_POINTS = 120
# Un onglet rechargé peut laisser une connexion morte en place : on garde une
# place de libre, mais pas plus (chaque flux coûte de la RAM).
MAX_STREAM_CLIENTS = 2
STREAM_IDLE_KEEPALIVE_MS = 3_000

# La LED suit le débit d'impulsions. À 50 impulsions/s, une période de
# clignotement couvre 10 impulsions, soit 5 clignotements par seconde :
# assez lent pour se voir, et plus rapide si le capteur accélère.
LED_PULSES_PER_BLINK = 10
LED_RATE_WINDOW_MS = 250
LED_MIN_HALF_MS = 20
LED_MAX_HALF_MS = 1000
