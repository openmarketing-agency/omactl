#!/bin/sh
set -eu
cd /var/www/html
wp core is-installed
wp eval '
$admin = get_user_by("login", getenv("WORDPRESS_ADMIN_USER"));
if (!$admin || !user_can($admin, "manage_options")) { throw new Exception("Configured administrator missing"); }
wp_set_current_user($admin->ID);
$body = "omactl-verify-" . wp_generate_uuid4();
$post = 0;
$file = null;
try {
    $request = new WP_REST_Request("POST", "/wp/v2/posts");
    $request->set_param("title", $body);
    $request->set_param("content", $body);
    $request->set_param("status", "draft");
    $response = rest_do_request($request);
    if ($response->get_status() !== 201) { throw new Exception("REST post creation failed"); }
    $post = (int) $response->get_data()["id"];
    $read = new WP_REST_Request("GET", "/wp/v2/posts/" . $post);
    $read->set_param("context", "edit");
    $result = rest_do_request($read);
    if ($result->get_status() !== 200 || trim($result->get_data()["content"]["raw"]) !== $body) { throw new Exception("REST post readback mismatch"); }
    $file = wp_upload_bits($body . ".txt", null, $body);
    if ($file["error"] || file_get_contents($file["file"]) !== $body) { throw new Exception("Upload readback mismatch"); }
    $http = wp_remote_get("http://wordpress/?rest_route=/", array("timeout" => 20));
    if (is_wp_error($http) || wp_remote_retrieve_response_code($http) !== 200) { throw new Exception("Apache REST endpoint unavailable"); }
    $index = json_decode(wp_remote_retrieve_body($http), true);
    if (!isset($index["routes"]["/wp/v2/posts"])) { throw new Exception("Unexpected HTTP REST response"); }
} finally {
    if ($post) { wp_delete_post($post, true); }
    if ($file && !$file["error"]) { wp_delete_file($file["file"]); }
}
echo "WordPress REST, database, uploads and HTTP checks passed.\n";
'
