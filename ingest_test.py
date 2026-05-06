import urllib.request
import json
import time

memories = [
    "Vorrei vedere Dune parte 2, me lo ha consigliato Marco",
    "Ristorante etiope fantastico vicino a Navigli, si chiama Lalibela",
    "Comprare regalo di compleanno per Sara, ama i profumi Aesop",
    "Idea progetto: app per tracciare le abitudini di lettura con AI",
    "Libro da leggere: La mente del leader di Rasmus Hougaard",
    "Palestra: prenotare lezione di yoga giovedì mattina",
    "Serie tv da finire: Severance stagione 2",
    "Podcast interessante su AI: Lex Friedman con Sam Altman",
    "Ricetta da provare: ramen fatto in casa con brodo di pollo 12 ore",
    "Volo per Barcellona a giugno, cercare prezzi su Kayak",
    "Riunione con team venerdì alle 15, preparare slides KPI Q2",
    "Caffè ottimo da Lunatica in zona Isola, da portare clienti",
    "Corso online di machine learning su Coursera di Andrew Ng",
    "Bisogna rivedere la strategia di pricing entro fine mese",
    "Film da vedere con Giulia: Everything Everywhere All at Once",
    "Dentista appuntamento da fissare per pulizia denti, urgente",
    "Viaggio a Tokyo: visitare il mercato del pesce Tsukiji e Shibuya",
    "Idea startup: marketplace per servizi di dog sitting in Italia",
    "Articolo sul deep work di Cal Newport, salvarlo per dopo",
    "Comprare cuffie Sony WH-1000XM5 quando scendono sotto 250 euro",
    "Rinnovare il dominio robertobiagetti.com a luglio",
    "Tra 2 giorni mi scade Spotify, ricordarmelo",
]

for i, mem in enumerate(memories):
    print(f"[{i+1}/{len(memories)}] {mem[:60]}...")
    data = json.dumps({"text": mem}).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:3000/api/parse",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
            p = result.get("parsed", {})
            print(f"  → {p.get('type')} | {p.get('domain')} | entities: {[e['name'] for e in p.get('entities', [])]}")
    except Exception as e:
        print(f"  → ERRORE: {e}")
    if i < len(memories) - 1:
        time.sleep(5)

print("\nDONE — tutte le memorie ingested!")
