<?php
/**
 * showmanager single sign-on for pirtonplayers.org (Joomla 4/5).
 *
 * Put this file in the Joomla root (next to configuration.php) and add a menu item of type
 * "External URL" pointing at /showmanager-sso.php, visible to Registered users only. For a
 * member who's logged in it sends them, signed with a shared secret, to showmanager's ssoLogin
 * Cloud Function (functions/index.js), which signs them in to the account with the same email.
 * Someone not logged in is sent to the Joomla login first and brought back here afterwards. A
 * member with no showmanager account yet gets an Expenses-only one created automatically.
 *
 * Set SHOWMANAGER_SSO_SECRET in configuration.php's environment or (simplest) replace the
 * placeholder below — same value as the Firebase secret: `firebase functions:secrets:set SSO_SECRET`.
 * Make it long and random (e.g. `openssl rand -hex 32`) and don't commit the real one.
 */

const SHOWMANAGER_SSO_SECRET = 'c0d52050-1ba5-41a6-b6e5-63d275fe9519';
// Joomla user group IDs allowed through (Users → Groups; e.g. [2] = Registered, or your own
// "Members" group's ID). Empty = any logged-in user. Recommended: list only your members' group.
const SHOWMANAGER_SSO_ALLOWED_GROUPS = [];
const SHOWMANAGER_SSO_URL = 'https://europe-west1-pirton-players-showmanager.cloudfunctions.net/ssoLogin';

define('_JEXEC', 1);
define('JPATH_BASE', __DIR__);
require_once JPATH_BASE . '/includes/defines.php';
require_once JPATH_BASE . '/includes/framework.php';

use Joomla\CMS\Application\SiteApplication;
use Joomla\CMS\Factory;
use Joomla\CMS\Uri\Uri;

$container = Factory::getContainer();
$app = $container->get(SiteApplication::class);
Factory::$application = $app;
$app->createExtensionNamespaceMap();
$user = $app->getIdentity();

if ($user->guest || !$user->email) {
    $return = base64_encode(Uri::root() . basename(__FILE__));
    header('Location: ' . Uri::root() . 'index.php?option=com_users&view=login&return=' . urlencode($return));
    exit;
}

if (SHOWMANAGER_SSO_ALLOWED_GROUPS && !array_intersect($user->getAuthorisedGroups(), SHOWMANAGER_SSO_ALLOWED_GROUPS)) {
    http_response_code(403);
    exit('Your account does not have access to showmanager.');
}

$email = strtolower(trim($user->email));
$name = mb_substr(trim($user->name), 0, 100) ?: $email;
$ts = (string) time();
$nonce = bin2hex(random_bytes(16));
$sig = hash_hmac('sha256', $email . "\n" . $name . "\n" . $ts . "\n" . $nonce, SHOWMANAGER_SSO_SECRET);

header('Cache-Control: no-store');
header('Referrer-Policy: no-referrer');
header('Location: ' . SHOWMANAGER_SSO_URL . '?' . http_build_query(['email' => $email, 'name' => $name, 'ts' => $ts, 'nonce' => $nonce, 'sig' => $sig]));
exit;
