<?php
// Sends all mail over SMTP to the host in SMTP_HOST, Mailpit in the proofy sandbox.
add_action('phpmailer_init', function ($mailer) {
    $mailer->isSMTP();
    $mailer->Host = getenv('SMTP_HOST') ?: 'mailpit';
    $mailer->Port = 1025;
    $mailer->SMTPAuth = false;
    $mailer->SMTPAutoTLS = false;
});
