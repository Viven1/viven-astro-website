-- Regla fija: todo email automatizado en ALEMÁN va en Sie + APELLIDO.
-- El template de review_request DE tuteaba ("dein Video") y usaba first_name.
update public.email_templates
set body = 'Guten Tag {{last_name}},

Es war uns eine Freude, Ihr Video zu produzieren — wir hoffen, es arbeitet bereits fleissig für Sie.

Wenn Sie 60 Sekunden haben: Eine kurze Google-Bewertung würde unserem kleinen Team enorm helfen — und macht es anderen Unternehmen leichter, uns zu finden.

Herzlichen Dank — bis zum nächsten Projekt!
Sebastian & das Viven-Team'
where key = 'review_request' and lang = 'de';
