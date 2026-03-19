function buildBookMetadataQuery(userId, bookIds) {
  var ids = Array.isArray(bookIds) ? bookIds.filter(Boolean).map(String) : [];
  var sql = "SELECT b.id, b.title, b.author, b.filename, s.chapters " +
    "FROM books b " +
    "LEFT JOIN book_structure s ON s.book_id = b.id " +
    "WHERE b.user_id = ?";
  var args = [String(userId || "default")];

  if (ids.length > 0) {
    var placeholders = ids.map(function() { return "?"; }).join(", ");
    sql += " AND b.id IN (" + placeholders + ")";
    args = args.concat(ids);
  }

  return { sql: sql, args: args };
}

module.exports = {
  buildBookMetadataQuery
};
